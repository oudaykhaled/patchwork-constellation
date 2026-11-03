import { afterEach, describe, expect, test, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { demoSnapshot } from '@patchwork/fixtures';
import { createStore, type SnapshotStore } from '@patchwork/storage';
import { createApplicationServer } from '../../apps/web/server';
import { GitHubAppAuth, AuthError, type GitHubSession } from '../../apps/web/github-auth';
import type { runAnalysisInWorker, runSourceAnalysisInWorker } from '../../apps/worker/src/index';

class QueueAuth extends GitHubAppAuth {
  removed = new Set<string>(); active = true; credentialOwners: string[] = [];
  constructor() { super({ appId: '1', clientId: 'synthetic', clientSecret: 'synthetic', privateKey: '', origin: 'http://127.0.0.1' }); }
  override session(req: IncomingMessage): GitHubSession | undefined {
    const user = req.headers.cookie;
    return this.active && (user === 'alice' || user === 'bob') ? { id: user, ownerId: `github:${user}`, login: user, csrf: 'csrf-test', expiresAt: Date.now() + 60_000 } : undefined;
  }
  override async repositoryToken(session: GitHubSession, repository: string) {
    if (repository !== 'acme/private' || this.removed.has(session.ownerId)) throw new AuthError('Repository removed', 403, 'REPOSITORY_DENIED');
    return `server-token-${session.ownerId}`;
  }
  override async credentialsForOwner(ownerId: string, repository: string) {
    this.credentialOwners.push(ownerId);
    if (!this.active) throw new AuthError('Session required', 403, 'AUTH_SESSION_REQUIRED');
    const session = this.session({ headers: { cookie: ownerId.slice('github:'.length) } } as IncomingMessage);
    if (!session) throw new AuthError('Session required', 403, 'AUTH_SESSION_REQUIRED');
    return { token: await this.repositoryToken(session, repository), allowPrivate: true as const };
  }
}
type AppServer = Awaited<ReturnType<typeof createApplicationServer>>;
const servers: AppServer[] = [], cleanup: (() => Promise<void>)[] = [];
async function start(auth: QueueAuth, options: { store?: SnapshotStore; runAnalysis: typeof runAnalysisInWorker; runSources?: typeof runSourceAnalysisInWorker }) {
  const server = await createApplicationServer({ production: true, auth, ...options }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; auth.config.origin = base;
  const headers = (user = 'alice') => ({ Cookie: user, Origin: base, 'X-CSRF-Token': 'csrf-test', 'Content-Type': 'application/json' });
  const post = (path: string, value: unknown, user = 'alice') => fetch(base + path, { method: 'POST', headers: headers(user), body: JSON.stringify(value) });
  const get = (path: string, user = 'alice') => fetch(base + path, { headers: headers(user) });
  return { server, base, post, get };
}
function snapshot(token?: string) { const value = structuredClone(demoSnapshot); value.id = 'same-snapshot-id'; value.mode = 'github'; value.repository = { owner: 'acme', name: 'private', fullName: 'acme/private', htmlUrl: 'https://github.com/acme/private', defaultBranch: 'main' }; value.groups[0]!.label = token?.endsWith('alice') ? 'Alice evidence' : 'Bob evidence'; return value; }
async function close(server: AppServer) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await server.analysisJobs.close(); }
afterEach(async () => { await Promise.all(servers.splice(0).map(close)); await Promise.all(cleanup.splice(0).map(run => run())); });

describe('authenticated durable queue boundaries', () => {
  test('rechecks credentials and isolates equal snapshot IDs in graph, file, and job APIs', async () => {
    const auth = new QueueAuth(), run: typeof runAnalysisInWorker = vi.fn(async (_input, options) => snapshot(options?.token));
    const app = await start(auth, { runAnalysis: run });
    const aliceJob = await (await app.post('/api/analyze', { repository: 'acme/private' })).json();
    await vi.waitFor(async () => expect((await app.get(`/api/jobs/${aliceJob.jobId}`).then(r => r.json())).status).toBe('ready'));
    expect((await app.get(`/api/jobs/${aliceJob.jobId}?repository=acme/private`, 'bob')).status).toBe(404);
    for (const path of ['/api/snapshots/same-snapshot-id', '/api/graphs/same-snapshot-id', `/api/files/same-snapshot-id/${encodeURIComponent(demoSnapshot.nodes[0]!.id)}`]) {
      expect((await app.get(path, 'bob')).status).toBe(404);
      expect((await app.get(path + '?repository=acme/private', 'bob')).status).toBe(404);
      expect((await app.get(path)).status).toBe(200);
    }
    const bobJob = await (await app.post('/api/analyze', { repository: 'acme/private' }, 'bob')).json();
    await vi.waitFor(async () => expect((await app.get(`/api/jobs/${bobJob.jobId}`, 'bob').then(r => r.json())).status).toBe('ready'));
    expect((await app.get('/api/graphs/same-snapshot-id').then(r => r.json())).groups[0].label).toBe('Alice evidence');
    expect((await app.get('/api/graphs/same-snapshot-id', 'bob').then(r => r.json())).groups[0].label).toBe('Bob evidence');
    expect(auth.credentialOwners.filter(owner => owner === 'github:alice').length).toBeGreaterThanOrEqual(2);
    const job = await app.get(`/api/jobs/${aliceJob.jobId}?includeSnapshot=false`).then(r => r.json()); expect(job).not.toHaveProperty('snapshot'); expect(JSON.stringify(job)).not.toContain('server-token');
    auth.removed.add('github:alice');
    expect((await app.get('/api/graphs/same-snapshot-id')).status).toBe(403);
    expect((await app.get(`/api/jobs/${aliceJob.jobId}`)).status).toBe(403);
    expect((await app.get('/api/graphs/same-snapshot-id', 'bob')).status).toBe(200);
  });

  test('recovery runs in the persisted owner scope after an authenticated reconnect', async () => {
    const store = await createStore({ databaseUrl: '' }), realClose = store.close.bind(store); store.close = async () => {}; cleanup.push(realClose);
    const firstAuth = new QueueAuth();
    const firstRun: typeof runAnalysisInWorker = vi.fn((_input, options) => new Promise<ReturnType<typeof snapshot>>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Restart', 'AbortError')), { once: true })));
    const first = await start(firstAuth, { store, runAnalysis: firstRun });
    const { jobId } = await (await first.post('/api/analyze', { repository: 'acme/private' })).json();
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledTimes(1)); await close(first.server); servers.splice(servers.indexOf(first.server), 1);
    await vi.waitFor(async () => expect((await store.getJob({ ownerId: 'github:alice', repository: 'acme/private' }, jobId))?.status).toBe('queued'));
    const secondAuth = new QueueAuth(); secondAuth.active = false;
    const resumed: typeof runAnalysisInWorker = vi.fn(async (_input, options) => snapshot(options?.token));
    const second = await start(secondAuth, { store, runAnalysis: resumed });
    expect((await second.get(`/api/jobs/${jobId}?repository=acme/private`)).status).toBe(401); expect(resumed).not.toHaveBeenCalled();
    secondAuth.active = true;
    await vi.waitFor(async () => expect((await second.get(`/api/jobs/${jobId}?repository=acme/private`).then(r => r.json())).status).toBe('ready'), { timeout: 3_000 });
    expect(secondAuth.credentialOwners).toContain('github:alice');
    expect((await store.getSnapshot({ ownerId: 'github:alice', repository: 'acme/private' }, 'same-snapshot-id'))?.groups[0]?.label).toBe('Alice evidence');
    expect(await store.getSnapshot({ ownerId: 'local-public', repository: 'acme/private' }, 'same-snapshot-id')).toBeUndefined();
    expect((await second.get('/api/graphs/same-snapshot-id?repository=acme/private', 'bob')).status).toBe(404);
  });

  test('purge cancels and fences a late worker completion so private snapshots cannot reappear', async () => {
    const auth = new QueueAuth(), store = await createStore({ databaseUrl: '' });
    let complete!: (value: ReturnType<typeof snapshot>) => void, signal: AbortSignal | undefined;
    const run: typeof runAnalysisInWorker = vi.fn((_input, options) => { signal = options?.signal; return new Promise<ReturnType<typeof snapshot>>(resolve => { complete = resolve; }); });
    const app = await start(auth, { store, runAnalysis: run });
    const { jobId } = await (await app.post('/api/analyze', { repository: 'acme/private' })).json(); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    auth.removed.add('github:alice'); await app.server.purgeRepository({ ownerId: 'github:alice', repository: 'acme/private' });
    expect(signal?.aborted).toBe(true); complete(snapshot('server-token-github:alice'));
    await vi.waitFor(async () => expect((await app.server.analysisJobs.operationalStatus('github:alice')).activeWorkersInProcess).toBe(0));
    const owner = { ownerId: 'github:alice', repository: 'acme/private' };
    expect(await store.getSnapshot(owner, 'same-snapshot-id')).toBeUndefined(); expect(await store.getJob(owner, jobId)).toBeUndefined();
    auth.removed.delete('github:alice');
    expect((await app.get('/api/graphs/same-snapshot-id?repository=acme/private')).status).toBe(404);
    expect((await app.get(`/api/jobs/${jobId}?repository=acme/private`)).status).toBe(404);
  });

  test('purge fences a source overlay that finishes after its cancellation', async () => {
    const auth = new QueueAuth(), store = await createStore({ databaseUrl: '' }), owner = { ownerId: 'github:alice', repository: 'acme/private' };
    const value = snapshot('server-token-github:alice'); value.sources[0]!.loaded = false;
    await store.putSnapshot(owner, value);
    let complete!: (value: ReturnType<typeof snapshot>) => void, signal: AbortSignal | undefined;
    const sources: typeof runSourceAnalysisInWorker = vi.fn((_snapshot, _kind, _ids, options) => { signal = options?.signal; return new Promise<ReturnType<typeof snapshot>>(resolve => { complete = resolve; }); });
    const app = await start(auth, { store, runAnalysis: async () => value, runSources: sources });
    expect((await app.get('/api/snapshots/same-snapshot-id?repository=acme/private')).status).toBe(200);
    const loading = app.post('/api/sources', { snapshotId: value.id, kind: value.sources[0]!.kind, ids: [value.sources[0]!.id] });
    await vi.waitFor(() => expect(sources).toHaveBeenCalledTimes(1));
    auth.removed.add(owner.ownerId); await app.server.purgeRepository(owner); expect(signal?.aborted).toBe(true);
    complete(value); expect((await loading).status).toBe(409);
    expect(await store.getSnapshot(owner, value.id)).toBeUndefined();
    auth.removed.delete(owner.ownerId); expect((await app.get('/api/graphs/same-snapshot-id?repository=acme/private')).status).toBe(404);
  });

  test('purge waits for an in-flight grouping snapshot write then removes its result and cached revision', async () => {
    const auth = new QueueAuth(), store = await createStore({ databaseUrl: '' }), owner = { ownerId: 'github:alice', repository: 'acme/private' }, value = snapshot('server-token-github:alice');
    const write = store.putSnapshot.bind(store); let delay = false, release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { entered = resolve; });
    store.putSnapshot = async (scope, next) => { if (delay && scope.ownerId === owner.ownerId && scope.repository === owner.repository) { entered(); await gate; } return write(scope, next); };
    await store.putSnapshot(owner, value);
    const app = await start(auth, { store, runAnalysis: async () => value });
    expect((await app.get('/api/snapshots/same-snapshot-id?repository=acme/private')).status).toBe(200);
    const current = await app.get('/api/grouping/current?snapshotId=same-snapshot-id').then(response => response.json());
    delay = true;
    const changing = app.post('/api/grouping/mutate', { snapshotId: value.id, expectedRevisionId: current.revision.id, operation: { type: 'rename', groupId: value.groups[0]!.id, label: 'Late private override' } });
    await began;
    auth.removed.add(owner.ownerId); let purged = false;
    const purging = app.server.purgeRepository(owner).then(() => { purged = true; });
    await Promise.resolve(); expect(purged).toBe(false);
    release(); expect((await changing).status).toBe(409); await purging;
    expect(await store.getSnapshot(owner, value.id)).toBeUndefined();
    auth.removed.delete(owner.ownerId); delay = false;
    const { jobId } = await (await app.post('/api/analyze', { repository: 'acme/private' })).json();
    await vi.waitFor(async () => expect((await app.get(`/api/jobs/${jobId}`).then(r => r.json())).status).toBe('ready'));
    expect((await app.get('/api/graphs/same-snapshot-id').then(r => r.json())).groups[0].label).toBe('Alice evidence');
  });

  test('policy preview enforces live owner access and configured exclusions without provider analysis', async () => {
    vi.stubEnv('AI_EXCLUDED_PATHS', `${demoSnapshot.nodes[0]!.path}\ncustom/private/**, generated/**`);
    try {
      const auth = new QueueAuth(), run: typeof runAnalysisInWorker = vi.fn(async (_input, options) => snapshot(options?.token));
      const app = await start(auth, { runAnalysis: run });
      const { jobId } = await (await app.post('/api/analyze', { repository: 'acme/private' })).json();
      await vi.waitFor(async () => expect((await app.get(`/api/jobs/${jobId}`).then(r => r.json())).status).toBe('ready'));
      const preview = await app.post('/api/grouping/policy', { snapshotId: 'same-snapshot-id' });
      expect(preview.status).toBe(200); const policy = await preview.json();
      expect(policy.excludedFiles).toBeGreaterThanOrEqual(1); expect(policy.sourceExcerpts).toBe(false);
      expect(policy.metadata.files.some((file: { id: string }) => file.id === demoSnapshot.nodes[0]!.id)).toBe(false);
      expect(JSON.stringify(policy)).not.toContain(demoSnapshot.nodes[0]!.path);
      expect((await app.post('/api/grouping/policy', { snapshotId: 'same-snapshot-id' }, 'bob')).status).toBe(404);
      auth.removed.add('github:alice'); expect((await app.post('/api/grouping/policy', { snapshotId: 'same-snapshot-id' })).status).toBe(403);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); }
  });
});
