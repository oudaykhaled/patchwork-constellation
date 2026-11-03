import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createPostgresWebhookInbox } from './webhook-inbox';

it.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL webhook enqueue survives an inbox restart with deduplication and tenant-scoped state', async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL!;
  const deliveryId = `test-${randomUUID()}`, scope = { ownerId: `webhook-test-${randomUUID()}`, repository: 'synthetic/example' };
  const task = { scope, installationId: 31, repositoryId: 72, kind: 'refresh' as const, reason: 'push' as const };
  const first = await createPostgresWebhookInbox({ databaseUrl });
  try { expect(await first.enqueue({ deliveryId, tasks: [task], createdAt: new Date().toISOString() })).toBe(true); } finally { await first.close(); }
  const second = await createPostgresWebhookInbox({ databaseUrl });
  try {
    expect(await second.enqueue({ deliveryId, tasks: [task], createdAt: new Date().toISOString() })).toBe(false);
    const delivery = await second.claim(); expect(delivery?.deliveryId).toBe(deliveryId);
    if (!delivery) throw new Error('Expected a durable delivery after restart');
    await second.mark(task, 'synthetic-job'); expect(await second.state(scope)).toMatchObject({ jobId: 'synthetic-job', revision: 1 });
    expect(await second.state({ ...scope, ownerId: 'outsider' })).toBeUndefined();
    await second.finish(delivery);
  } finally { await second.close(); }
  // The suite deliberately leaves a bounded, synthetic-only dedup row until 7-day retention.
});
