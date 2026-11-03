import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { demoSnapshot } from '@patchwork/fixtures';
import { createApplicationServer } from '../../apps/web/server';
import { GitHubAppAuth, type GitHubSession } from '../../apps/web/github-auth';

class ControlledAuth extends GitHubAppAuth {
  constructor() { super({ appId: '1', clientId: 'synthetic', clientSecret: 'synthetic', privateKey: '', origin: 'http://127.0.0.1' }); }
  override session(req: IncomingMessage): GitHubSession | undefined { const cookie = req.headers.cookie; return cookie === 'alice' || cookie === 'bob' ? { id: cookie, ownerId: `github:${cookie}`, login: cookie, csrf: 'synthetic-csrf', expiresAt: Date.now() + 100_000 } : undefined; }
}
const auth = new ControlledAuth(); let server: Server; let base: string;
beforeAll(async () => { vi.stubEnv('OPS_METRICS_ENABLED', 'true'); vi.stubEnv('AI_ENABLED', 'false'); server = await createApplicationServer({ production: true, auth }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; auth.config.origin = base; });
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); });
test('metrics require opt-in and an authenticated current owner, without cross-owner activity', async () => {
  expect((await fetch(base + '/api/metrics')).status).toBe(401);
  expect((await fetch(base + '/api/readiness')).status).toBe(200);
  await fetch(base + '/api/demo', { headers: { Cookie: 'alice' } });
  const proposal = await fetch(base + '/api/grouping', { method: 'POST', headers: { Cookie: 'alice', 'X-CSRF-Token': 'synthetic-csrf', 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ snapshotId: demoSnapshot.id, enabled: true }) }); expect(proposal.status).toBe(200);
  const alice = await fetch(base + '/api/metrics', { headers: { Cookie: 'alice' } }).then(value => value.json()); const bob = await fetch(base + '/api/metrics', { headers: { Cookie: 'bob' } }).then(value => value.json());
  expect(alice.provider.observations).toBe(1); expect(bob.provider.observations).toBe(0); expect(bob.queue.activeWorkersInProcess).toBe(0); expect(JSON.stringify(alice)).not.toMatch(/alice|github:|patchwork-demo|platform|synthetic-csrf/);
  vi.stubEnv('OPS_METRICS_ENABLED', 'false'); expect((await fetch(base + '/api/metrics', { headers: { Cookie: 'alice' } })).status).toBe(404);
});
