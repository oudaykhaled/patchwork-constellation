import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApplicationServer } from '../../apps/web/server';
import { WebhookRefreshService } from '../../apps/web/webhook-refresh';
import { MemoryWebhookInbox } from '../../packages/storage/src/webhook-inbox';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
async function start(webhooks?: WebhookRefreshService) {
  const server = await createApplicationServer({ production: true, webhooks }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
it('unconfigured webhook ingress fails closed without requiring browser CSRF', async () => {
  const base = await start();
  const response = await fetch(base + '/api/webhooks/github', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'WEBHOOK_UNCONFIGURED' });
});
it('HTTP ingress persists the exact signed payload before ack, and independent refresh routes retain origin protection', async () => {
  const secret = 'synthetic-hook-test-secret'; const scope = { ownerId: 'local-public', repository: 'acme/example' };
  const binding = { scope, installationId: 31, repositoryId: 72 };
  const inbox = new MemoryWebhookInbox(); const enqueue = vi.spyOn(inbox, 'enqueue');
  const enqueueRefresh = vi.fn(async () => ({ jobId: 'refresh-job' }));
  const service = new WebhookRefreshService({ secret, inbox, allowVolatileInboxForTests: true, resolveInstallation: async () => [binding], resolveScope: async () => binding, enqueueRefresh, invalidateMetadata() {}, invalidateAuthorization() {}, purgeRepository: async () => {} });
  const base = await start(service); const raw = JSON.stringify({ installation: { id: 31 }, repository: { id: 72, full_name: 'acme/example' }, ref: 'refs/heads/main', after: 'b'.repeat(40) });
  const send = (body: string) => fetch(base + '/api/webhooks/github', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Delivery': 'delivery-http-test', 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` }, body });
  expect((await send(raw + ' ')).status).toBe(401); expect(enqueue).not.toHaveBeenCalled();
  const accepted = await send(raw); expect(accepted.status).toBe(202); expect(await accepted.json()).toMatchObject({ queued: 1 }); expect(enqueue).toHaveBeenCalledOnce();
  expect(enqueueRefresh).not.toHaveBeenCalled();
  expect((await send(raw)).status).toBe(202);
  await service.processOne(); expect(enqueueRefresh).toHaveBeenCalledOnce();
  const status = await fetch(base + '/api/refresh?repository=acme/example'); expect(await status.json()).toMatchObject({ available: true, state: { stale: true, jobId: 'refresh-job' } });
  const denied = await fetch(base + '/api/refresh/reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' }, body: JSON.stringify({ repository: 'acme/example' }) });
  expect(denied.status).toBe(403);
  const reconcile = await fetch(base + '/api/refresh/reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: 'acme/example' }) });
  expect(reconcile.status).toBe(202); expect(await reconcile.json()).toMatchObject({ state: { reason: 'reconcile' } });
});
