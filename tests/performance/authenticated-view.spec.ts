import { expect, test, type BrowserContext } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createApplicationServer } from '../../apps/web/server';
import { GitHubAppAuth, type GitHubSession } from '../../apps/web/github-auth';
import { createScaleFixture } from '../../packages/fixtures/src/index';
import { createStore } from '../../packages/storage/src/index';
import { GroupingService } from '../../packages/ai/src/index';

const repository = 'fixture/benchmark';
const graph = createScaleFixture(2_000, 8_000, 42);
graph.id = 'controlled-authenticated-2k-v1'; graph.mode = 'github';
graph.repository = { owner: 'fixture', name: 'benchmark', fullName: repository, defaultBranch: 'main', htmlUrl: 'https://github.com/' + repository };
graph.edges = graph.edges.map(edge => ({ ...edge, evidence: { ...(typeof edge.evidence === 'object' ? edge.evidence : {}), path: graph.nodes.find(node => node.id === edge.source)!.path, resolver: 'authored-release-fixture-v1', snapshotSha: graph.contextSha } }));
graph.coverage.reasons = ['Authored synthetic 2k/8k evidence; no real private repository or live provider call.'];
let repositoryAvailable = true, controlsVerified = false, analysisCalls = 0, authDiscoveryCalls = 0, session: Awaited<ReturnType<typeof createApplicationServer>>, base: string;

// The production session issuer, opaque-cookie lookup, CSRF guard and live user/
// installation intersection are real. Only installation-token minting and upstream
// GitHub responses are test doubles; no real App key is loaded or generated.
class ControlledTokenAuth extends GitHubAppAuth {
  constructor() {
    super({ appId: '777', clientId: 'authored-test-client', clientSecret: 'synthetic-only', privateKey: '', origin: 'http://127.0.0.1' }, { fetch: async input => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'synthetic-user-token', token_type: 'bearer' });
      if (url === 'https://api.github.com/user') return Response.json({ id: 777, login: 'authored-benchmark-reviewer' });
      if (url.startsWith('https://api.github.com/user/installations?')) { authDiscoveryCalls++; return Response.json({ installations: [{ id: 888 }] }); }
      if (url.startsWith('https://api.github.com/user/installations/888/repositories?')) return Response.json({ repositories: repositoryAvailable ? [{ id: 999, full_name: repository, private: true }] : [] });
      throw new Error('Unrecognized controlled authentication request; no outbound fallback allowed.');
    } });
  }
  override async repositoryToken(account: GitHubSession, requestedRepository: string, installationId?: number) {
    await this.authorize(account, requestedRepository, installationId);
    return 'synthetic-readonly-installation-token';
  }
}
const auth = new ControlledTokenAuth();

async function signIn(context: BrowserContext) {
  const login = await context.request.get(base + '/api/auth/login', { maxRedirects: 0 });
  expect(login.status()).toBe(302);
  const redirect = new URL(login.headers().location);
  expect(redirect.origin).toBe('https://github.com');
  const response = await context.request.get(`${base}/api/auth/callback?code=authored-test-code&state=${encodeURIComponent(redirect.searchParams.get('state')!)}`, { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  const account = await context.request.get(base + '/api/auth/session');
  const value = await account.json();
  expect(value.authenticated).toBe(true); expect(value.login).toBe('authored-benchmark-reviewer');
  expect(typeof value.csrf).toBe('string');
  return value.csrf as string;
}

test.describe('Controlled authenticated BFF response to useful graph @performance', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    const store = await createStore({ databaseUrl: '' });
    session = await createApplicationServer({ production: true, store, auth, grouping: new GroupingService({ enabled: false }),
      resolveAnalysisInput: async input => ({ ...input, contextRef: graph.contextSha, displayContextRef: 'authored-fixture-reference' }),
      runAnalysis: async (_input, options) => { expect(options?.token).toBe('synthetic-readonly-installation-token'); analysisCalls++; return structuredClone(graph); },
      runSources: async snapshot => structuredClone(snapshot),
    });
    await new Promise<void>((resolve, reject) => { session.once('error', reject); session.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(session.address() as AddressInfo).port}`; auth.config.origin = base;
  });
  test.afterAll(async () => { if (session) { session.closeAllConnections(); await new Promise<void>(resolve => session.close(() => resolve())); await session.analysisJobs.close(); } });

  test('real guards reject missing/tampered sessions, missing CSRF and removed access', async ({ browser }) => {
    const anonymous = await browser.newContext();
    try {
      const denied = await anonymous.request.post(base + '/api/analyze', { data: { repository } }); expect(denied.status()).toBe(401);
      await anonymous.addCookies([{ name: 'constellation_session', value: 'authored-tampered-cookie', url: base }]);
      expect((await anonymous.request.get(base + '/api/snapshots/' + graph.id)).status()).toBe(401);
    } finally { await anonymous.close(); }
    const context = await browser.newContext();
    try {
      const csrf = await signIn(context);
      expect((await context.request.post(base + '/api/analyze', { headers: { Origin: base }, data: { repository } })).status()).toBe(403);
      expect(analysisCalls).toBe(0);
      repositoryAvailable = false;
      const removed = await context.request.post(base + '/api/analyze', { headers: { Origin: base, 'X-CSRF-Token': csrf }, data: { repository } });
      expect(removed.status()).toBe(403); expect(analysisCalls).toBe(0);
      controlsVerified = true;
    } finally { repositoryAvailable = true; await context.close(); }
  });

  test('records body-arrival to actual worker-ready file pixels on the authenticated cached graph', async ({ browser, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'This measured Resource Timing / canvas sample is recorded on Chromium.');
    expect(controlsVerified, 'Run the complete serial authenticated-performance configuration, including its denial controls.').toBe(true);
    const sampleCount = Math.max(5, Math.min(100, Number(process.env.AUTHENTICATED_VIEW_SAMPLES) || 20));
    test.setTimeout(sampleCount * 10_000 + 30_000);
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const samples: { responseEndMs: number; usefulPixelsMs: number; responseToUsefulMs: number; workerCount: number; warm: boolean; payloadBytes: number }[] = [];
    const pageErrors: string[] = [], unexpectedOrigins: string[] = [];
    try {
      await signIn(context);
      // First run fills the real owner-scoped queue/snapshot cache; later page loads
      // exercise its reused completed job while retaining live authorization checks.
      for (let sample = 0; sample <= sampleCount; sample++) {
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('request', request => { if (new URL(request.url()).origin !== base) unexpectedOrigins.push(new URL(request.url()).origin); });
        await page.addInitScript(() => {
          const state = { responseEndMs: 0, usefulPixelsMs: 0, workerCount: 0, payloadBytes: 0 };
          Object.assign(window, { __authenticatedViewEvidence: state });
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker { constructor(...args: ConstructorParameters<typeof Worker>) { super(...args); state.workerCount++; } };
          const inspect = () => {
            if (state.usefulPixelsMs) return;
            const readyPayload = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter(entry => /\/api\/jobs\//.test(entry.name) && entry.encodedBodySize > 20_000 && entry.responseEnd > 0).at(-1);
            const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="graph-canvas"]');
            const surface = document.querySelector<HTMLElement>('[data-testid="graph-surface"]');
            if (readyPayload && canvas?.getAttribute('aria-label')?.includes('2000 files') && surface?.dataset.layoutState === 'ready') {
              const context = canvas.getContext('2d');
              if (context) {
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                let green = 0;
                for (let i = 0; i < pixels.length; i += 16) if (pixels[i + 1] > 90 && pixels[i + 1] > pixels[i] * 1.35 && pixels[i + 2] < 150) green++;
                if (green > 100) { state.responseEndMs = readyPayload.responseEnd; state.payloadBytes = readyPayload.encodedBodySize; state.usefulPixelsMs = performance.now(); return; }
              }
            }
            requestAnimationFrame(inspect);
          };
          requestAnimationFrame(inspect);
        });
        await page.goto(`${base}/?repo=${encodeURIComponent(repository)}&context=${graph.contextSha}&sources=scale-pr-1,scale-pr-2`);
        await expect.poll(() => page.evaluate(() => (window as unknown as { __authenticatedViewEvidence: { usefulPixelsMs: number } }).__authenticatedViewEvidence.usefulPixelsMs), { timeout: 15_000 }).toBeGreaterThan(0);
        const observed = await page.evaluate(() => (window as unknown as { __authenticatedViewEvidence: { responseEndMs: number; usefulPixelsMs: number; workerCount: number; payloadBytes: number } }).__authenticatedViewEvidence);
        expect(observed.workerCount).toBeGreaterThan(0); expect(observed.payloadBytes).toBeGreaterThan(20_000);
        expect(observed.usefulPixelsMs).toBeGreaterThan(observed.responseEndMs);
        samples.push({ ...observed, responseToUsefulMs: observed.usefulPixelsMs - observed.responseEndMs, warm: sample > 0 });
        await expect(page.getByTestId('graph-canvas')).toHaveAttribute('aria-label', /2000 files/);
        await page.close();
      }
      expect(analysisCalls).toBe(1); expect(authDiscoveryCalls).toBeGreaterThan(sampleCount);
      expect(pageErrors).toEqual([]); expect(unexpectedOrigins).toEqual([]);
      const sorted = samples.filter(sample => sample.warm).map(sample => sample.responseToUsefulMs).sort((a, b) => a - b);
      const p95Ms = sorted[Math.ceil(sorted.length * .95) - 1];
      const report = { schemaVersion: '1', measuredAt: new Date().toISOString(), commit: process.env.RELEASE_EVIDENCE_COMMIT || 'unspecified', status: p95Ms <= 2_000 ? 'passed' : 'failed', sampleKind: 'controlled-authenticated-BFF', files: 2_000, edges: 8_000, seed: 42, sampleCount, p95Ms, targetMs: 2_000, samples,
        conditions: { build: 'production', platform: process.platform, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version, browser: browser.version(), viewport: { width: 1600, height: 1000 }, dpr: 1, network: 'same-origin loopback HTTP; no artificial network throttling', concurrentActivity: process.env.RELEASE_EVIDENCE_ACTIVITY || 'unspecified', origin: 'ephemeral loopback test server' },
        controls: { noSession: '401', tamperedSession: '401', missingCsrf: '403', removedRepository: '403', unauthorizedAnalysisCalls: 0, analysisCalls, liveDiscoveryCalls: authDiscoveryCalls, externalRequests: unexpectedOrigins.length },
        timer: 'Browser ResourceTiming.responseEnd for the authenticated ready-job JSON body containing the graph, through actual Canvas2D file pixels and data-layout-state=ready. Module navigation and synthetic analysis generation are outside this interval.',
        limitations: ['Synthetic identity and authored graph only; no live GitHub App registration/private-repository permission or provider credential is verified.', 'Actual production opaque-session issuance/lookup, CSRF, BFF authorization and user-installation intersection run with controlled GitHub responses. Only token minting and repository analysis/source transport are dependency-injected test doubles.', 'No App private key is loaded or generated, no production bypass route is added, and no browser API response is intercepted.', 'Warm samples reuse the actual completed owner-scoped BFF job. This is a declared local reference, not WAN/staging/GPU or human-journey evidence.'] };
      const json = JSON.stringify(report, null, 2);
      const directory = resolve(process.env.RELEASE_EVIDENCE_DIR || '.tmp/release-evidence');
      await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, 'authenticated-view.json'), json + '\n');
      await testInfo.attach('authenticated-view.json', { body: json, contentType: 'application/json' });
      console.log('Controlled authenticated response-to-useful-view:', JSON.stringify({ samples: sampleCount, p95Ms, analysisCalls, authDiscoveryCalls }));
      expect(p95Ms).toBeLessThanOrEqual(2_000);
    } finally { await context.close(); }
  });
});
