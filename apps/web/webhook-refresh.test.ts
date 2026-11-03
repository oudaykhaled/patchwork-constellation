import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemoryWebhookInbox, type WebhookEnvelope } from '../../packages/storage/src/webhook-inbox';
import { WebhookRefreshService, type WebhookRefreshOptions } from './webhook-refresh';

const secret = 'synthetic-webhook-secret-for-tests';
const scope = { ownerId: 'user:alice', repository: 'acme/example' };
const binding = { scope, installationId: 31, repositoryId: 72 };
const payload = { installation: { id: 31 }, repository: { id: 72, full_name: 'acme/example' }, ref: 'refs/heads/main', after: 'a'.repeat(40), commits: [{ message: 'UNTRUSTED source text must not persist' }] };
function signed(value: unknown, event = 'push', deliveryId = 'delivery-00000001') {
  const raw = Buffer.from(JSON.stringify(value));
  return { raw, headers: { signature: `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`, event, deliveryId } };
}
function fixture(overrides: Partial<WebhookRefreshOptions> = {}) {
  const inbox = new MemoryWebhookInbox();
  const hooks = { resolveInstallation: vi.fn(async () => [binding]), resolveScope: vi.fn(async () => binding), enqueueRefresh: vi.fn(async () => ({ jobId: 'new-job' })), invalidateMetadata: vi.fn(), invalidateAuthorization: vi.fn(), purgeRepository: vi.fn(async () => {}) };
  return { inbox, hooks, service: new WebhookRefreshService({ secret, inbox, ...hooks, allowVolatileInboxForTests: true, ...overrides }) };
}
describe('verified webhook refresh', () => {
  it('denies unconfigured durability and altered raw bytes before routing or writes', async () => {
    expect(() => new WebhookRefreshService({ ...fixture().hooks, secret, inbox: new MemoryWebhookInbox() })).toThrow('durable');
    const { service, hooks, inbox } = fixture(); const event = signed(payload);
    await expect(service.accept(Buffer.concat([event.raw, Buffer.from(' ')]), event.headers)).rejects.toMatchObject({ status: 401 });
    expect(hooks.resolveInstallation).not.toHaveBeenCalled(); expect(await inbox.claim()).toBeUndefined();
  });
  it('atomically records replay identity and sanitized work before ack, never analyzes inline', async () => {
    const { service, inbox, hooks } = fixture(); const event = signed(payload);
    const enqueue = vi.spyOn(inbox, 'enqueue');
    expect(await service.accept(event.raw, event.headers)).toEqual({ accepted: true, duplicate: false, queued: 1 });
    expect(enqueue).toHaveBeenCalledOnce(); expect(JSON.stringify(enqueue.mock.calls[0])).not.toContain('UNTRUSTED');
    expect(hooks.enqueueRefresh).not.toHaveBeenCalled();
    expect(await service.accept(event.raw, event.headers)).toMatchObject({ duplicate: true, queued: 0 });
    await service.processOne(); expect(hooks.enqueueRefresh).toHaveBeenCalledOnce();
    expect(await service.state(scope)).toMatchObject({ stale: true, revoked: false, jobId: 'new-job', reason: 'push' });
    expect(await service.state({ ...scope, ownerId: 'user:bob' })).toBeUndefined();
  });
  it('failed durable enqueue remains retryable instead of consuming its delivery id', async () => {
    const { service, inbox } = fixture(); const event = signed(payload);
    vi.spyOn(inbox, 'enqueue').mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.accept(event.raw, event.headers)).rejects.toThrow('database unavailable');
    expect(await service.accept(event.raw, event.headers)).toMatchObject({ duplicate: false, queued: 1 });
  });
  it('signed payload names and installation ids never grant repository/owner authority', async () => {
    const { service, hooks } = fixture({ resolveInstallation: async id => id === 31 ? [binding] : [] });
    for (const [index, value] of [{ ...payload, repository: { id: 999, full_name: 'acme/example' } }, { ...payload, repository: { id: 72, full_name: 'evil/private' } }, { ...payload, installation: { id: 999 } }].entries()) {
      const event = signed(value, 'push', `delivery-noauth-${index}`); expect(await service.accept(event.raw, event.headers)).toMatchObject({ queued: 0 }); await service.processOne();
    }
    expect(hooks.enqueueRefresh).not.toHaveBeenCalled();
  });
  it('out-of-order PR synchronize/base edits and force-push enqueue current-ref refresh, never event SHA', async () => {
    const { service, hooks } = fixture();
    const events = [signed({ ...payload, forced: true }, 'push', 'delivery-forcepush'), signed({ ...payload, action: 'synchronize', pull_request: { head: { sha: 'OLD_SHA' } } }, 'pull_request', 'delivery-old-pr'), signed({ ...payload, action: 'edited', changes: { base: { ref: { from: 'old-base' } } } }, 'pull_request', 'delivery-base-pr')];
    for (const event of events) await service.accept(event.raw, event.headers);
    while (await service.processOne()) { /* bounded to three deliveries */ }
    expect(hooks.enqueueRefresh).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(hooks.enqueueRefresh.mock.calls)).not.toMatch(/OLD_SHA|aaaaaaa|old-base/);
    expect(await service.state(scope)).toMatchObject({ stale: true, reason: 'pull_request', revision: 3 });
  });
  it('installation deletion invalidates immediately after enqueue and purges every known scoped cache off-request', async () => {
    const other = { ...binding, scope: { ...scope, ownerId: 'user:bob' } };
    const { service, hooks } = fixture({ resolveInstallation: async () => [binding, other] });
    const event = signed({ installation: { id: 31 }, action: 'deleted' }, 'installation');
    expect(await service.accept(event.raw, event.headers)).toMatchObject({ queued: 2 });
    expect(hooks.invalidateAuthorization).toHaveBeenCalledWith(31); expect(hooks.purgeRepository).not.toHaveBeenCalled();
    await service.processOne(); expect(hooks.purgeRepository).toHaveBeenCalledTimes(2); expect(hooks.enqueueRefresh).not.toHaveBeenCalled();
    expect(await service.state(scope)).toMatchObject({ revoked: true });
  });
  it('repository removal routes only known numeric IDs and a later live-authorized reconcile clears stale revocation', async () => {
    const { service, hooks } = fixture();
    const event = signed({ installation: { id: 31 }, action: 'removed', repositories_removed: [{ id: 72, full_name: 'attacker/ignored' }, { id: 900 }] }, 'installation_repositories');
    await service.accept(event.raw, event.headers); expect(hooks.invalidateAuthorization).toHaveBeenCalledWith(31, 72);
    await service.processOne(); expect(await service.state(scope)).toMatchObject({ revoked: true });
    expect(await service.reconcile(scope)).toMatchObject({ revoked: false, reason: 'reconcile', jobId: 'new-job' });
  });
  it('rechecks current scope for queued work and never exposes missing-access results', async () => {
    const { service, hooks } = fixture({ resolveScope: async () => undefined }); const event = signed(payload);
    await service.accept(event.raw, event.headers); await service.processOne();
    expect(hooks.enqueueRefresh).not.toHaveBeenCalled(); expect(hooks.purgeRepository).toHaveBeenCalledWith(scope);
    expect(await service.state(scope)).toMatchObject({ revoked: true });
    await expect(service.reconcile(scope)).rejects.toMatchObject({ status: 403 });
  });
  it('recovers redelivery after worker outage and transient queue failure with bounded delay', async () => {
    let now = Date.now(); const inbox = new MemoryWebhookInbox({ now: () => now });
    const { service, hooks } = fixture({ inbox }); const event = signed(payload);
    await service.accept(event.raw, event.headers); hooks.enqueueRefresh.mockRejectedValueOnce(new Error('worker unavailable'));
    await service.processOne(); expect(await service.processOne()).toBe(false);
    now += 1001;
    const restarted = fixture({ inbox }); await restarted.service.processOne();
    expect(restarted.hooks.enqueueRefresh).toHaveBeenCalledOnce();
    expect(await restarted.service.accept(event.raw, event.headers)).toMatchObject({ duplicate: true });
  });
  it('lease expiry reclaims interrupted work; retention/capacity remains bounded', async () => {
    let now = Date.now(); const inbox = new MemoryWebhookInbox({ now: () => now, maxEntries: 1, retentionMs: 100_000 });
    const envelope: WebhookEnvelope = { deliveryId: 'delivery-reclaim', createdAt: new Date(now).toISOString(), tasks: [] };
    await inbox.enqueue(envelope); const first = (await inbox.claim())!;
    expect(await inbox.claim()).toBeUndefined(); now += 60_001; const next = (await inbox.claim())!; expect(next.lease).not.toBe(first.lease);
    await inbox.finish(first); expect(await inbox.claim()).toBeUndefined(); await inbox.finish(next);
    await expect(inbox.enqueue({ ...envelope, deliveryId: 'delivery-overflow' })).rejects.toMatchObject({ status: 503 });
    now += 100_001; expect(await inbox.enqueue({ ...envelope, deliveryId: 'delivery-afterexpiry' })).toBe(true);
  });
});
