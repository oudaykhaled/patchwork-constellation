import { afterAll, beforeAll, expect, test } from 'vitest';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { demoSnapshot } from '@patchwork/fixtures';
import { createApplicationServer } from '../../apps/web/server';
import { AuthError, GitHubAppAuth, type GitHubSession } from '../../apps/web/github-auth';

class ControlledAuth extends GitHubAppAuth {
  removed = new Set<string>();
  constructor() { super({ appId: '1', clientId: 'synthetic', clientSecret: 'synthetic', privateKey: '', origin: 'http://127.0.0.1' }); }
  override session(req: IncomingMessage): GitHubSession | undefined { const name = req.headers.cookie; return name === 'alice' || name === 'bob' ? { id: name, ownerId: `github:${name}`, login: name, csrf: 'synthetic-csrf', expiresAt: Date.now() + 100_000 } : undefined; }
  override async authorize(session: GitHubSession, repository: string) { if (repository !== 'acme/private' || this.removed.has(session.ownerId)) throw new AuthError('Repository access removed.', 403, 'REPOSITORY_DENIED'); return { id: 1, full_name: repository, private: true, installationId: 2 }; }
  override async repositoryToken(session: GitHubSession, repository: string) { await this.authorize(session, repository); return `test-token-${session.ownerId}`; }
  override async credentialsForOwner(ownerId: string, repository: string) {
    const session = this.session({ headers: { cookie: ownerId.replace(/^github:/, '') } } as IncomingMessage);
    if (!session) throw new AuthError('Reconnect GitHub.', 403, 'AUTH_SESSION_REQUIRED');
    return { token: await this.repositoryToken(session, repository), allowPrivate: true as const };
  }
}
let server: Server, base: string;
const auth = new ControlledAuth();
const receivedTokens: (string | undefined)[] = [];
beforeAll(async () => {
  server = await createApplicationServer({ production: true, auth, runAnalysis: async (_input, options) => {
    receivedTokens.push(options?.token);
    return { ...structuredClone(demoSnapshot), id: 'shared-private-snapshot', mode: 'github', repository: { ...demoSnapshot.repository, owner: 'acme', name: 'private', fullName: 'acme/private' } };
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; auth.config.origin = base;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
const post = (path: string, value: unknown, cookie = 'alice', csrf = true) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base, ...(csrf ? { 'X-CSRF-Token': 'synthetic-csrf' } : {}) }, body: JSON.stringify(value) });
async function ready(id: string, user: string) {
  for (let count = 0; count < 50; count++) { const result = await fetch(`${base}/api/jobs/${id}`, { headers: { Cookie: user } }); const job = await result.json(); if (job.status === 'ready') return job; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Controlled analysis did not finish');
}
test('configured App mode gates private APIs, preserves public demo, and enforces CSRF', async () => {
  expect((await fetch(base + '/api/demo')).status).toBe(200);
  expect((await fetch(base + '/api/snapshots/shared-private-snapshot')).status).toBe(401);
  expect((await post('/api/analyze', { repository: 'acme/private' }, 'alice', false)).status).toBe(403);
  expect((await fetch(base + '/api/config').then(r => r.json())).github.appConfigured).toBe(true);
});
test('repository and job access is rechecked; cache cannot bypass removal or cross-user ownership', async () => {
  const submitted = await post('/api/analyze', { repository: 'acme/private' }); expect(submitted.status).toBe(202);
  const { jobId } = await submitted.json(); await ready(jobId, 'alice');
  expect(receivedTokens).toContain('test-token-github:alice');
  const serialized = JSON.stringify(await fetch(`${base}/api/jobs/${jobId}`, { headers: { Cookie: 'alice' } }).then(r => r.json())); expect(serialized).not.toContain('test-token');
  expect((await fetch(`${base}/api/jobs/${jobId}`, { headers: { Cookie: 'bob' } })).status).toBe(404);
  expect((await fetch(base + '/api/snapshots/shared-private-snapshot', { headers: { Cookie: 'bob' } })).status).toBe(404);
  expect((await fetch(base + '/api/snapshots/shared-private-snapshot', { headers: { Cookie: 'alice' } })).status).toBe(200);
  auth.removed.add('github:alice');
  expect((await fetch(base + '/api/snapshots/shared-private-snapshot', { headers: { Cookie: 'alice' } })).status).toBe(403);
  expect((await fetch(`${base}/api/jobs/${jobId}`, { headers: { Cookie: 'alice' } })).status).toBe(403);
});
