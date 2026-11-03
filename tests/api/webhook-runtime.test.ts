import { createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { demoSnapshot } from '@patchwork/fixtures';
import { createStore, createPostgresWebhookInbox, MemoryWebhookInbox } from '@patchwork/storage';
import { createApplicationServer } from '../../apps/web/server';
import { GitHubAppAuth, AuthError, type GitHubSession } from '../../apps/web/github-auth';
import type { runAnalysisInWorker } from '../../apps/worker/src/index';

const secret = 'synthetic-configured-runtime-webhook-secret';
const repository = 'acme/private';
class RuntimeAuth extends GitHubAppAuth {
  removed = new Set<string>();
  constructor() { super({ appId: '31', clientId: 'synthetic', clientSecret: 'synthetic', privateKey: '', origin: 'http://127.0.0.1' }); }
  override session(req: IncomingMessage): GitHubSession | undefined { const user = req.headers.cookie; return user === 'alice' || user === 'bob' ? { id: user, ownerId: `github:${user}`, login: user, csrf: 'runtime-csrf', expiresAt: Date.now() + 60_000 } : undefined; }
  override async repositories(session: GitHubSession) { return this.removed.has(session.ownerId) ? [] : [{ id: 72, full_name: repository, private: true, installationId: 31 }]; }
  override async repositoryToken(session: GitHubSession, fullName: string) { await this.authorize(session, fullName); return `runtime-token-${session.ownerId}`; }
  override async credentialsForOwner(ownerId: string, fullName: string) {
    const session = this.session({ headers: { cookie: ownerId.replace(/^github:/, '') } } as IncomingMessage);
    if (!session) throw new AuthError('Reconnect GitHub.', 403);
    return { token: await this.repositoryToken(session, fullName), allowPrivate: true as const };
  }
}
// Only the storage boundary is simulated when no test database is supplied. The
// factory, auth binding registry, current-ref pinning, queue and purge are real.
class RuntimeTestInbox extends MemoryWebhookInbox { override readonly durable = true; }
type App = Awaited<ReturnType<typeof createApplicationServer>>;
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) { app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); await app.analysisJobs.close(); await app.webhooks?.close(); }
  vi.unstubAllEnvs();
});
function snapshot(sha = 'a'.repeat(40), title = 'Initial sources') {
  const value = structuredClone(demoSnapshot);
  return { ...value, id: `private-${sha}`, mode: 'github' as const, contextSha: sha, contextRef: 'main', repository: { owner: 'acme', name: 'private', fullName: repository, htmlUrl: 'https://github.com/acme/private', defaultBranch: 'main' }, edges: value.edges.map(edge => ({ ...edge, evidence: { path: value.nodes.find(node => node.id === edge.source)!.path, snapshotSha: sha, resolver: 'authored-webhook-fixture' } })), sources: value.sources.map(source => ({ ...source, title })) };
}
async function fixture(run?: typeof runAnalysisInWorker) {
  const auth = new RuntimeAuth(), store = await createStore({ databaseUrl: '' });
  const state = { head: 'a'.repeat(40), sourceVersion: 'Initial sources' }, pinned: string[] = [];
  const analyze: typeof runAnalysisInWorker = run ?? vi.fn(async input => snapshot(input.contextRef, state.sourceVersion));
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const inbox = databaseUrl ? await createPostgresWebhookInbox({ databaseUrl }) : new RuntimeTestInbox();
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', secret); vi.stubEnv('DATABASE_URL', databaseUrl ?? 'postgresql://synthetic@127.0.0.1/controlled-test');
  const app = await createApplicationServer({ production: true, auth, store, webhookInbox: inbox, runAnalysis: analyze, resolveAnalysisInput: async (input, credentials) => {
    expect(credentials?.token).toMatch(/^runtime-token-github:/); pinned.push(input.contextRef ?? 'main');
    return { ...input, contextRef: state.head, displayContextRef: input.contextRef ?? 'main' };
  } });
  apps.push(app); await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`; auth.config.origin = base;
  const headers = (user = 'alice') => ({ Cookie: user, Origin: base, 'X-CSRF-Token': 'runtime-csrf', 'Content-Type': 'application/json' });
  const post = (path: string, value: unknown, user = 'alice') => fetch(base + path, { method: 'POST', headers: headers(user), body: JSON.stringify(value) });
  const get = (path: string, user = 'alice') => fetch(base + path, { headers: headers(user) });
  const send = async (event: string, payload: unknown, id = randomUUID()) => {
    const raw = JSON.stringify(payload);
    const response = await fetch(base + '/api/webhooks/github', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': id, 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` }, body: raw });
    return { response, result: await response.json(), id };
  };
  const delivery = { installation: { id: 31 }, repository: { id: 72, full_name: repository } };
  const drain = async () => { for (let count = 0; count < 10; count++) if (!await app.webhooks!.processOne()) break; };
  return { app, auth, store, state, pinned, analyze, post, get, send, delivery, process: drain };
}
it('configured factory routes only prior live bindings, refreshes source-only updates, deduplicates and preserves old snapshots', async () => {
  const app = await fixture();
  const unknown = await app.send('push', { ...app.delivery, after: 'UNTRUSTED-EVENT-SHA' }); expect(unknown.response.status).toBe(202); expect(unknown.result.queued).toBe(0); await app.process(); expect(app.analyze).not.toHaveBeenCalled();
  const initial = await (await app.post('/api/analyze', { repository })).json();
  await vi.waitFor(async () => expect((await app.get(`/api/jobs/${initial.jobId}`).then(response => response.json())).status).toBe('ready'));
  expect(app.auth.knownRepositoryBindings(31)).toMatchObject([{ ownerId: 'github:alice', repositoryId: 72 }]);
  const old = await app.get(`/api/jobs/${initial.jobId}`).then(response => response.json());
  app.state.sourceVersion = 'Updated PR source';
  const accepted = await app.send('pull_request', { ...app.delivery, action: 'synchronize', pull_request: { head: { sha: 'UNTRUSTED-EVENT-SHA' } } });
  expect(accepted.response.status).toBe(202); expect(accepted.result.queued).toBe(1);
  const replay = await app.send('pull_request', { ...app.delivery, action: 'synchronize' }, accepted.id); expect(replay.result.duplicate).toBe(true);
  await app.process();
  const feed = await app.get(`/api/refresh?repository=${repository}`).then(response => response.json()); expect(feed.state.jobId).not.toBe(initial.jobId);
  await vi.waitFor(async () => expect((await app.get(`/api/jobs/${feed.state.jobId}`).then(response => response.json())).status).toBe('ready'));
  const refreshed = await app.get(`/api/jobs/${feed.state.jobId}`).then(response => response.json());
  expect(refreshed.snapshot.id).not.toBe(old.snapshot.id); expect(refreshed.snapshot.contextSha).toBe(old.snapshot.contextSha);
  expect(refreshed.snapshot.sources[0].title).toBe('Updated PR source');
  expect((await app.get(`/api/snapshots/${old.snapshot.id}`).then(response => response.json())).sources[0].title).toBe('Initial sources');
  expect(app.pinned).toEqual(['main', 'main']); expect(app.analyze).toHaveBeenCalledTimes(2);
  const outsider = await app.get(`/api/refresh?repository=${repository}`, 'bob').then(response => response.json()); expect(outsider.state).toBeUndefined();
  expect(JSON.stringify(feed)).not.toMatch(/runtime-token|UNTRUSTED/);
});
it('out-of-order force-push and PR-base events pin current server refs; reconcile preserves the requested branch', async () => {
  const app = await fixture(); const initial = await (await app.post('/api/analyze', { repository, contextRef: 'feature/review' })).json();
  await vi.waitFor(async () => expect((await app.get(`/api/jobs/${initial.jobId}`).then(response => response.json())).status).toBe('ready'));
  app.state.head = 'b'.repeat(40);
  await app.send('push', { ...app.delivery, after: 'c'.repeat(40), forced: true }); await app.process();
  await app.send('pull_request', { ...app.delivery, action: 'edited', changes: { base: { ref: { from: 'older-branch' } } }, pull_request: { head: { sha: 'd'.repeat(40) } } }); await app.process();
  const feed = await app.get(`/api/refresh?repository=${repository}`).then(response => response.json());
  await vi.waitFor(async () => expect((await app.get(`/api/jobs/${feed.state.jobId}`).then(response => response.json())).status).toBe('ready'));
  expect((await app.get(`/api/jobs/${feed.state.jobId}`).then(response => response.json())).snapshot.contextSha).toBe('b'.repeat(40));
  expect(app.pinned).toEqual(['feature/review', 'feature/review', 'feature/review']);
  const reconciliation = await app.post('/api/refresh/reconcile', { repository, contextRef: 'another/context' }); expect(reconciliation.status).toBe(202);
  expect(app.pinned.at(-1)).toBe('another/context');
});
it('verified removal invokes the actual purge fence and a late private worker cannot resurrect data', async () => {
  let complete!: (value: ReturnType<typeof snapshot>) => void, signal: AbortSignal | undefined;
  const run: typeof runAnalysisInWorker = vi.fn((_input, options) => { signal = options?.signal; return new Promise<ReturnType<typeof snapshot>>(resolve => { complete = resolve; }); });
  const app = await fixture(run); const owner = { ownerId: 'github:alice', repository };
  const { jobId } = await (await app.post('/api/analyze', { repository })).json(); await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  app.auth.removed.add(owner.ownerId);
  const removed = await app.send('installation_repositories', { installation: { id: 31 }, action: 'removed', repositories_removed: [{ id: 72, full_name: 'body/name-is-not-authority' }] });
  expect(removed.response.status).toBe(202); expect(removed.result.queued).toBe(1); expect(app.auth.knownRepositoryBindings(31)).toEqual([]);
  await app.process(); expect(signal?.aborted).toBe(true); complete(snapshot());
  await vi.waitFor(async () => expect((await app.app.analysisJobs.operationalStatus(owner.ownerId)).activeWorkersInProcess).toBe(0));
  expect(await app.store.getSnapshot(owner, snapshot().id)).toBeUndefined(); expect(await app.store.getJob(owner, jobId)).toBeUndefined();
  app.auth.removed.delete(owner.ownerId);
  expect((await app.get(`/api/snapshots/${snapshot().id}?repository=${repository}`)).status).toBe(404);
  expect((await app.get(`/api/jobs/${jobId}?repository=${repository}`)).status).toBe(404);
  const feed = await app.get(`/api/refresh?repository=${repository}`).then(response => response.json()); expect(feed.state.revoked).toBe(true);
});
it('invalid webhook configuration fails closed and disposes the initialized store', async () => {
  const store = await createStore({ databaseUrl: '' }), close = vi.spyOn(store, 'close');
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'too-short'); vi.stubEnv('DATABASE_URL', 'postgresql://synthetic@127.0.0.1/controlled-test');
  await expect(createApplicationServer({ production: true, auth: new RuntimeAuth(), store, webhookInbox: new RuntimeTestInbox() })).rejects.toThrow('at least 16');
  expect(close).toHaveBeenCalledOnce();
});
