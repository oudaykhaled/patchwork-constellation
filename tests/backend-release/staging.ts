import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createScaleFixture } from '@patchwork/fixtures';
import { createPostgresWebhookInbox, createStore, type SnapshotStore } from '@patchwork/storage';
import { GitHubAppAuth } from '../../apps/web/github-auth';
import { createApplicationServer } from '../../apps/web/server';

type Application = Awaited<ReturnType<typeof createApplicationServer>>;
type Account = { cookie: string; csrf: string };

/** Real BFF/session/CSRF/queue/storage boundaries; upstream GitHub stays controlled. */
export async function runStagingChecks(output = '.tmp/staging/data-09.json') {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (process.env.STAGING_REHEARSAL !== '1' || !databaseUrl) throw new Error('Explicit isolated staging opt-in is required');
  const database = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) || !/^\/constellation_[a-z0-9_]+$/.test(database.pathname)) throw new Error('Staging requires a named synthetic loopback PostgreSQL database');
  const started = performance.now(), nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const repository = `fixture/staging-${nonce}`, hiddenRepository = `fixture/retained-${nonce}`;
  const aliceId = 10_000_000 + Math.floor(Math.random() * 1_000_000), bobId = aliceId + 2_000_000;
  const aliceScope = { ownerId: `github:${aliceId}`, repository }, bobScope = { ownerId: `github:${bobId}`, repository };
  const hiddenScope = { ...aliceScope, repository: hiddenRepository };
  const checks: { id: string; status: 'passed'; durationMs: number }[] = [];
  const previous = new Map(['AI_ENABLED', 'DATABASE_URL', 'GITHUB_WEBHOOK_SECRET', 'NODE_ENV', 'API_REQUESTS_PER_MINUTE'].map(key => [key, process.env[key]]));
  const apps: Application[] = [];
  let observer: SnapshotStore | undefined;
  let progressive: unknown;
  let passed = false;
  const memoryBefore = process.memoryUsage();
  async function check(id: string, action: () => Promise<void>) { const start = performance.now(); await action(); checks.push({ id, status: 'passed', durationMs: Number((performance.now() - start).toFixed(2)) }); }
  try {
    process.env.AI_ENABLED = 'false'; process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = databaseUrl; process.env.API_REQUESTS_PER_MINUTE = '240';
    const webhookSecret = `synthetic-stage-${nonce}`; process.env.GITHUB_WEBHOOK_SECRET = webhookSecret;
    const allowed = new Set([aliceId, bobId]);
    let tokenMints = 0, discoveryCalls = 0;
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const auth = new GitHubAppAuth({ appId: '1776', clientId: 'authored-stage', clientSecret: 'synthetic-stage-only', privateKey: key, origin: 'http://127.0.0.1' }, { fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.href === 'https://github.com/login/oauth/access_token') {
        const payload = JSON.parse(String(init?.body)); const id = payload.code === 'alice' ? aliceId : payload.code === 'bob' ? bobId : 0;
        assert.ok(id, 'Only authored synthetic sign-ins are allowed');
        return Response.json({ access_token: `synthetic-user-${id}`, token_type: 'bearer' });
      }
      assert.equal(url.origin, 'https://api.github.com', 'Unexpected upstream origin');
      const credential = new Headers(init?.headers).get('Authorization') ?? '';
      const userId = Number(credential.replace('Bearer synthetic-user-', ''));
      if (url.pathname === '/user') return Response.json({ id: userId, login: userId === aliceId ? 'authored-alice' : 'authored-bob' });
      if (url.pathname === '/user/installations') { discoveryCalls++; return Response.json({ installations: [{ id: 1776 }] }); }
      if (url.pathname === '/user/installations/1776/repositories') return Response.json({ repositories: allowed.has(userId) ? [{ id: 1886, full_name: repository, private: true }] : [] });
      if (url.pathname === '/app/installations/1776/access_tokens') {
        assert.deepEqual(JSON.parse(String(init?.body)), { repository_ids: [1886], permissions: { contents: 'read', pull_requests: 'read', metadata: 'read' } });
        tokenMints++;
        return Response.json({ token: 'synthetic-installation-only', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      throw new Error('Unrecognized controlled upstream; outbound fallback is forbidden');
    } });
    observer = await createStore({ databaseUrl, autoMigrate: process.env.DATABASE_AUTO_MIGRATE !== 'false' });
    assert.equal(observer.kind, 'postgres');
    const store = await createStore({ databaseUrl, autoMigrate: process.env.DATABASE_AUTO_MIGRATE !== 'false' });
    const inbox = await createPostgresWebhookInbox({ databaseUrl, autoMigrate: process.env.DATABASE_AUTO_MIGRATE !== 'false' });
    const app = await createApplicationServer({ production: true, store, auth, webhookInbox: inbox }); apps.push(app);
    await new Promise<void>((ready, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', ready); });
    const origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`; auth.config.origin = origin;
    const graph = createScaleFixture(10_000, 40_000, 42); graph.id = `shared-staging-${nonce}`; graph.mode = 'github';
    graph.repository = { owner: 'fixture', name: `staging-${nonce}`, fullName: repository, defaultBranch: 'main', htmlUrl: `https://github.com/${repository}` };
    const paths = new Map(graph.nodes.map(node => [node.id, node.path]));
    graph.edges = graph.edges.map(edge => ({ ...edge, evidence: { path: paths.get(edge.source)!, snapshotSha: graph.contextSha, resolver: 'authored-staging-synthetic-v1' } }));
    graph.coverage.reasons = ['Authored synthetic graph; these edges are controlled staging data, not observed repository dependencies.'];
    const get = (path: string, account?: Account) => fetch(origin + path, { headers: account ? { Cookie: account.cookie } : {} });
    const post = (path: string, payload: unknown, account: Account, csrf = true) => fetch(origin + path, { method: 'POST', headers: { Cookie: account.cookie, Origin: origin, 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': account.csrf } : {}) }, body: JSON.stringify(payload) });
    async function signIn(user: 'alice' | 'bob'): Promise<Account> {
      const begun = await fetch(origin + '/api/auth/login', { redirect: 'manual' });
      assert.equal(begun.status, 302); const location = new URL(begun.headers.get('location')!);
      const browserCookie = begun.headers.getSetCookie()[0]!.split(';')[0]!;
      const completed = await fetch(`${origin}/api/auth/callback?code=${user}&state=${encodeURIComponent(location.searchParams.get('state')!)}`, { redirect: 'manual', headers: { Cookie: browserCookie } });
      assert.equal(completed.status, 303);
      const cookie = completed.headers.getSetCookie().find(value => value.startsWith('constellation_session='))!.split(';')[0]!;
      const session = await get('/api/auth/session', { cookie, csrf: '' }).then(response => response.json());
      assert.equal(session.authenticated, true); assert.equal(typeof session.csrf, 'string');
      return { cookie, csrf: session.csrf };
    }
    const alice = await signIn('alice'), sibling = await signIn('alice'), bob = await signIn('bob');
    const query = `?repository=${encodeURIComponent(repository)}`, graphPath = `/api/graphs/${graph.id}${query}`;
    await check('real-session-csrf-and-owner-isolation', async () => {
      assert.equal((await get(graphPath)).status, 401);
      assert.equal((await post('/api/analyze', { repository }, alice, false)).status, 403);
      await observer!.putSnapshot(aliceScope, graph);
      assert.equal((await get(graphPath, bob)).status, 404);
      const bobsGraph = structuredClone(graph); bobsGraph.groups[0]!.label = 'Authored Bob grouping';
      await observer!.putSnapshot(bobScope, bobsGraph);
      assert.equal((await get(graphPath, alice)).status, 200);
      assert.equal((await get(graphPath, bob).then(response => response.json())).groups[0].label, 'Authored Bob grouping');
      assert.equal((await get(`/api/graphs/${graph.id}?repository=foreign%2Frepository`, alice)).status, 404);
    });
    await check('cached-token-and-snapshot-revocation', async () => {
      const before = discoveryCalls;
      assert.equal((await get(graphPath, alice)).status, 200);
      assert.ok(tokenMints > 0 && discoveryCalls > before);
      allowed.delete(aliceId);
      assert.equal((await get(graphPath, alice)).status, 403);
      assert.equal((await get(graphPath, bob)).status, 200);
      allowed.add(aliceId);
    });
    await check('10k-postgres-bounded-progressive-delivery', async () => {
      const metadata = await get(graphPath, alice).then(response => response.json());
      assert.equal(metadata.counts.files, 10_000); assert.equal(metadata.counts.edges, 40_000);
      const ids = new Set<string>(), edgeIds = new Set<string>(), results = [];
      for (const kind of ['nodes', 'edges']) {
        let cursor: string | undefined, pages = 0, maxBytes = 0; const start = performance.now();
        do {
          const params = new URLSearchParams({ repository, kind, version: metadata.version, limit: kind === 'nodes' ? '500' : '1000', ...(cursor ? { cursor } : {}) });
          const response = await get(`/api/graphs/${graph.id}/chunks?${params}`, alice);
          assert.equal(response.status, 200); const text = await response.text();
          const bytes = Buffer.byteLength(text); maxBytes = Math.max(maxBytes, bytes); assert.ok(bytes < 512_000, 'Progressive page exceeded its byte budget');
          const page = JSON.parse(text); const seen = kind === 'nodes' ? ids : edgeIds;
          for (const item of page.items) { assert.ok(!seen.has(item.id), 'Duplicate progressive item'); seen.add(item.id); if (kind === 'edges') assert.ok(ids.has(item.source) && ids.has(item.target), 'Dangling edge endpoint'); }
          pages++; assert.ok(pages <= 60, 'Progressive cursor exceeded finite page budget'); cursor = page.nextCursor ?? undefined;
        } while (cursor);
        assert.equal(pages, kind === 'nodes' ? 20 : 40);
        results.push({ kind, pages, count: (kind === 'nodes' ? ids : edgeIds).size, maxBytes, totalMs: Number((performance.now() - start).toFixed(2)) });
      }
      assert.equal(ids.size, 10_000); assert.equal(edgeIds.size, 40_000); progressive = results;
    });
    await check('request-body-and-source-count-bounds', async () => {
      assert.equal((await post('/api/sources', { snapshotId: graph.id, kind: 'pr', ids: ['x'.repeat(129_000)] }, alice)).status, 413);
      assert.equal((await post('/api/sources', { snapshotId: graph.id, kind: 'pr', ids: Array.from({ length: 21 }, (_, index) => `pr:${index}`) }, alice)).status, 400);
    });
    await check('disconnect-purges-retained-data-and-all-owner-sessions', async () => {
      const hidden = structuredClone(graph); hidden.id = `retained-${nonce}`; hidden.repository = { ...hidden.repository, fullName: hiddenRepository, name: `retained-${nonce}`, htmlUrl: `https://github.com/${hiddenRepository}` };
      await observer!.putSnapshot(hiddenScope, hidden);
      assert.equal((await post('/api/auth/disconnect', {}, alice)).status, 200);
      assert.equal((await get(graphPath, sibling)).status, 401, 'Sibling owner session survived disconnect');
      assert.equal(Boolean(await observer!.getSnapshot(aliceScope, graph.id)), false, 'Disconnected owner snapshot remains stored');
      assert.equal(Boolean(await observer!.getSnapshot(hiddenScope, hidden.id)), false, 'Prior retained repository survived disconnect');
      assert.equal((await get(graphPath, bob)).status, 200, 'Disconnect removed another owner');
      const reconnected = await signIn('alice'); assert.equal((await get(graphPath, reconnected)).status, 404, 'Reconnect resurrected cached snapshot');
    });
    await check('signed-installation-removal-and-replay', async () => {
      const payload = JSON.stringify({ installation: { id: 1776 }, action: 'removed', repositories_removed: [{ id: 1886, full_name: 'untrusted/body-is-not-authority' }] });
      const deliveryId = randomUUID();
      const send = (signature: string) => fetch(origin + '/api/webhooks/github', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'installation_repositories', 'X-GitHub-Delivery': deliveryId, 'X-Hub-Signature-256': signature }, body: payload });
      assert.equal((await send(`sha256=${'0'.repeat(64)}`)).status, 401);
      const signature = `sha256=${createHmac('sha256', webhookSecret).update(payload).digest('hex')}`;
      const accepted = await send(signature); assert.equal(accepted.status, 202); assert.ok((await accepted.json()).queued > 0);
      assert.equal((await send(signature).then(response => response.json())).duplicate, true);
      for (let attempt = 0; attempt < 50 && await observer!.getSnapshot(bobScope, graph.id); attempt++) { await app.webhooks!.processOne(); await new Promise(ready => setTimeout(ready, 20)); }
      assert.equal(Boolean(await observer!.getSnapshot(bobScope, graph.id)), false, 'Removal left a stored snapshot');
      assert.equal((await get(graphPath, bob)).status, 404, 'Removal left a cached snapshot');
    });
    await check('per-server-rate-resource-bound', async () => {
      process.env.API_REQUESTS_PER_MINUTE = '4';
      delete process.env.GITHUB_WEBHOOK_SECRET;
      const limitedStore = await createStore({ databaseUrl, autoMigrate: process.env.DATABASE_AUTO_MIGRATE !== 'false' });
      const limited = await createApplicationServer({ production: true, auth: null, store: limitedStore }); apps.push(limited);
      await new Promise<void>((ready, reject) => { limited.once('error', reject); limited.listen(0, '127.0.0.1', ready); });
      const base = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
      for (let count = 0; count < 4; count++) assert.equal((await fetch(base + '/api/health')).status, 200);
      const denied = await fetch(base + '/api/health'); assert.equal(denied.status, 429); assert.ok(Number(denied.headers.get('retry-after')) > 0);
      process.env.API_REQUESTS_PER_MINUTE = '240'; process.env.GITHUB_WEBHOOK_SECRET = webhookSecret;
    });
    passed = true;
  } finally {
    for (const app of apps.reverse()) { app.closeAllConnections(); await new Promise<void>(ready => app.close(() => ready())); await app.analysisJobs.close(); await app.webhooks?.close(); }
    if (observer) { for (const scope of [aliceScope, bobScope, hiddenScope]) await observer.deleteRepository(scope); await observer.close(); }
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const memoryAfter = process.memoryUsage();
    const report = {
      schemaVersion: '1', status: passed ? 'passed' : 'failed', measuredAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
      conditions: { platform: platform(), osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), runtime: process.version, database: 'real isolated loopback PostgreSQL', deployment: process.env.GITHUB_ACTIONS === 'true' ? 'ephemeral GitHub Actions staging runner' : 'local isolated staging rehearsal', concurrency: 'Other agents or hosted jobs may be active; this is correctness/resource-bound verification, not a capacity benchmark', upstream: 'controlled OAuth/GitHub transport; real session issuer, CSRF, RSA token mint, HTTP, PostgreSQL and signed webhook logic; no external account/provider calls' },
      checks, progressive, totalMs: Number((performance.now() - started).toFixed(2)), resources: { requestBodyMaxBytes: 128_000, responsePageMaxBytes: 512_000, rateRequestsPerMinute: 4, observedRssBeforeBytes: memoryBefore.rss, observedRssAfterBytes: memoryAfter.rss, osContainmentClaimed: false },
      limitations: ['Synthetic identities/upstream transport do not establish a live GitHub App registration or external webhook delivery.', 'Memory observations are not a leak or production-capacity certificate; no kernel sandbox is claimed.', 'AI providers remain disabled; browser, GPU and human accessibility/evaluation gates belong to their own issues.'],
    };
    await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n');
  }
  return { status: 'passed', checks: checks.length, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runStagingChecks(process.argv[2]))); }
  catch { console.error('Staging verification failed. Inspect the allowlisted report and assertion locally; no environment or credential values are printed.'); process.exitCode = 1; }
}
