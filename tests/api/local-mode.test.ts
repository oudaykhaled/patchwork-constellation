import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GraphSnapshot } from '@patchwork/contracts';
import { createGitHistoryFixture, type GitHistoryFixture } from '../../packages/fixtures/src/git-history';
import { createApplicationServer } from '../../apps/web/server';
import { currentLocalGitRegistry } from '@patchwork/analysis';

// End to end through the HTTP server and the real analysis worker thread. The test
// client uses node:http so that global fetch can be stubbed to fail for the server.
let server: Server, port: number, root: string, fixture: GitHistoryFixture;
const saved = { LOCAL_REPOS: process.env.LOCAL_REPOS, LOCAL_REPOS_ONLY: process.env.LOCAL_REPOS_ONLY };
const outbound = vi.fn(() => { throw new Error('the server must not make outbound requests in local mode'); });
function call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => { try { resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T }); } catch (error) { reject(error); } });
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}
async function waitForSnapshot(jobId: string): Promise<GraphSnapshot> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = await call<{ status: string; snapshot?: GraphSnapshot; error?: string }>('GET', `/api/jobs/${jobId}?repository=local/fixture`);
    if (job.body.status === 'ready' && job.body.snapshot) return job.body.snapshot;
    if (['failed', 'cancelled'].includes(job.body.status)) throw new Error(`analysis ${job.body.status}: ${job.body.error}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('analysis did not finish');
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'patchwork-local-api-'));
  fixture = createGitHistoryFixture(join(root, 'work'));
  const mirror = join(root, 'fixture.git');
  execFileSync('git', ['clone', '--quiet', '--mirror', '--no-hardlinks', fixture.directory, mirror], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  writeFileSync(join(root, 'footprints.json'), JSON.stringify({ views: [{ id: 'review', title: 'Review set', sources: [{ kind: 'pr', number: 42, title: 'Recorded change', files: [{ path: 'src/shared.ts', status: 'modified' }, { path: 'src/new.ts', status: 'added' }], origin: 'test file' }, { kind: 'pr', number: 43, title: 'Recorded rename as two rows', files: [{ path: 'src/legacy.ts', status: 'removed' }, { path: 'src/renamed.ts', status: 'added' }], origin: 'test file' }] }] }));
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ version: 1, limits: { maxSnapshotBytes: 32 * 1_048_576, workerHeapMb: 512 }, repositories: [{ id: 'local/fixture', label: 'Fixture', gitDir: mirror, defaultRef: 'main', footprints: join(root, 'footprints.json') }] }));
  process.env.LOCAL_REPOS = join(root, 'registry.json'); process.env.LOCAL_REPOS_ONLY = 'true';
  vi.stubGlobal('fetch', outbound);
  server = await createApplicationServer({ production: true });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('local repository mode over HTTP', () => {
  it('advertises registered repositories without paths and keeps the host check', async () => {
    const config = await call<{ local: { enabled: boolean; only: boolean; repositories: unknown[] }; github: { publicRepositories: boolean } }>('GET', '/api/config');
    expect(config.status).toBe(200);
    expect(config.body.local).toMatchObject({ enabled: true, only: true, repositories: [{ fullName: 'local/fixture', label: 'Fixture', defaultRef: 'main' }] });
    expect(config.body.github.publicRepositories).toBe(false);
    // The worker launcher sizes local tasks from the registry the server loaded at startup.
    expect(currentLocalGitRegistry()?.limits).toMatchObject({ workerHeapMb: 512, maxSnapshotBytes: 32 * 1_048_576 });
    expect(JSON.stringify(config.body)).not.toContain(root);
    const hostile = await new Promise<number>((resolve, reject) => { const outgoing = request({ host: '127.0.0.1', port, path: '/api/config', headers: { Host: 'attacker.example' } }, incoming => { incoming.resume(); resolve(incoming.statusCode!); }); outgoing.on('error', reject); outgoing.end(); });
    expect(hostile).toBe(403);
  });

  it('rejects unregistered repositories before any GitHub request', async () => {
    const rejected = await call('POST', '/api/analyze', { repository: 'octocat/hello-world' });
    expect(rejected).toMatchObject({ status: 400, body: { code: 'LOCAL_ONLY' } });
    const path = await call('POST', '/api/analyze', { repository: '/etc/passwd' });
    expect(path.status).toBe(400);
    const ref = await call('POST', '/api/analyze', { repository: 'local/fixture', contextRef: 'no-such-branch' });
    expect(ref).toMatchObject({ status: 404, body: { code: 'LOCAL_REF' } });
    expect(outbound).not.toHaveBeenCalled();
  });

  it('analyzes, lists and loads local sources through the worker', { timeout: 60_000 }, async () => {
    // Worker threads use the registry the server loaded at startup. They never re-read the
    // file, so a later edit (here: an invalid file) neither costs a reload nor changes answers.
    writeFileSync(join(root, 'registry.json'), JSON.stringify({ version: 1, repositories: [] }));
    const submitted = await call<{ jobId: string }>('POST', '/api/analyze', { repository: 'local/fixture' });
    expect(submitted.status).toBe(202);
    const snapshot = await waitForSnapshot(submitted.body.jobId);
    expect(snapshot).toMatchObject({ mode: 'local-git', contextSha: fixture.refs.merge, contextRef: 'main', repository: { htmlUrl: 'local-git://local/fixture' } });
    expect((snapshot as { sourceViews?: unknown }).sourceViews).toEqual([{ id: 'review', title: 'Review set', kind: 'pr', sourceIds: ['pr:42', 'pr:43'], omitted: 0 }]);
    const commits = await call<{ sources: { id: string }[]; nextPage: number | null }>('GET', `/api/sources?snapshotId=${encodeURIComponent(snapshot.id)}&kind=commit&page=1`);
    expect(commits.status).toBe(200);
    expect(commits.body.sources.map(source => source.id)).toEqual([`commit:${fixture.refs.merge}`, `commit:${fixture.refs.root}`]);
    const loaded = await call<GraphSnapshot>('POST', '/api/sources', { snapshotId: snapshot.id, kind: 'commit', ids: [`commit:${fixture.refs.merge}`] });
    expect(loaded.status).toBe(200);
    const merge = loaded.body.sources.find(source => source.id === `commit:${fixture.refs.merge}`)!;
    expect(merge).toMatchObject({ loaded: true, fileEvidence: 'local-git-diff', comparisonKind: 'first-parent' });
    expect(merge.files.map(file => file.path)).toEqual(fixture.golden.featureA.map(change => change.path));
    // Recorded PRs after commits: the merge's rename links pr:43's two rows to one file.
    const recorded = await call<GraphSnapshot>('POST', '/api/sources', { snapshotId: snapshot.id, kind: 'pr', ids: ['pr:42', 'pr:43'] });
    expect(recorded.status).toBe(200);
    expect(recorded.body.sources.find(source => source.id === 'pr:42')).toMatchObject({ loaded: true, comparisonKind: 'recorded', fileEvidence: 'local-footprint-file', url: 'local-git://local/fixture/pull/42' });
    expect(recorded.body.sources.find(source => source.id === 'pr:43')!.files).toMatchObject([{ path: 'src/renamed.ts', previousPath: 'src/legacy.ts', status: 'renamed' }]);
    const graph = await call<{ nodeCount?: number }>('GET', `/api/graphs/${encodeURIComponent(snapshot.id)}`);
    expect(graph.status).toBe(200);
    expect(JSON.stringify(recorded.body)).not.toContain(root);
    expect(JSON.stringify(recorded.body)).not.toMatch(/https:\/\/github\.com\/local/);
    expect(outbound).not.toHaveBeenCalled();
  });
});

/**
 * Runs the real analysis thread with a preload that reports and blocks every network attempt
 * inside the thread. Stubbing fetch in this test process cannot see the worker's own globals.
 */
function runGuardedThread(workerData: unknown): Promise<{ attempts: string[]; result?: GraphSnapshot; error?: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../apps/worker/src/thread.ts', import.meta.url), { workerData, execArgv: ['--import', 'tsx', '--import', new URL('./worker-network-guard.ts', import.meta.url).href] });
    const outcome: { attempts: string[]; result?: GraphSnapshot; error?: string } = { attempts: [] };
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('guarded worker did not finish')); }, 40_000);
    worker.on('message', (message: { type: string; kind?: string; snapshot?: GraphSnapshot; error?: { message: string } }) => {
      if (message.type === 'network-attempt') outcome.attempts.push(message.kind!);
      else if (message.type === 'result') outcome.result = message.snapshot;
      else if (message.type === 'error') outcome.error = message.error?.message;
    });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    // The thread exits by itself once its work and its Git processes are done.
    worker.once('exit', () => { clearTimeout(timer); resolve(outcome); });
  });
}

describe('the analysis worker thread in local mode', () => {
  it('makes no network attempt while analyzing and loading a local repository', { timeout: 60_000 }, async () => {
    const repository = currentLocalGitRegistry()!.get('local/fixture')!;
    const local = { only: true, maxSnapshotBytes: 32 * 1_048_576, repository };
    const analyzed = await runGuardedThread({ task: { kind: 'repository', input: { repository: 'local/fixture' } }, options: {}, local });
    expect(analyzed.error).toBeUndefined();
    expect(analyzed.result).toMatchObject({ mode: 'local-git', contextSha: fixture.refs.merge });
    const loaded = await runGuardedThread({ task: { kind: 'sources', snapshot: analyzed.result, sourceKind: 'commit', ids: [`commit:${fixture.refs.merge}`] }, options: {}, local });
    expect(loaded.error).toBeUndefined();
    expect(loaded.result!.sources.find(source => source.id === `commit:${fixture.refs.merge}`)).toMatchObject({ loaded: true, fileEvidence: 'local-git-diff' });
    expect([...analyzed.attempts, ...loaded.attempts]).toEqual([]);
  });

  it('has a guard that does see network use inside the thread', { timeout: 60_000 }, async () => {
    // A GitHub repository in mixed mode goes to GitHub, so the guard must report it.
    const github = await runGuardedThread({ task: { kind: 'repository', input: { repository: 'acme/app' } }, options: { maxRetries: 0 }, local: { only: false, maxSnapshotBytes: 32 * 1_048_576 } });
    expect(github.attempts.length).toBeGreaterThan(0);
    expect(github.result).toBeUndefined();
    expect(github.error).toBeDefined();
  });
});
