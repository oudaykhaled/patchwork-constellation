import { authoredFileFacts } from '@patchwork/fixtures';
import { randomUUID, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GraphSnapshot } from '@patchwork/contracts';
import { acceptWebhookDelivery, createStore, newJob, verifyWebhook, type SnapshotStore, type StoreScope } from './index.js';

const snapshot: GraphSnapshot = {
  schemaVersion: '1',
  id: 'snapshot-1', repository: { owner: 'example', name: 'repo', fullName: 'example/repo', defaultBranch: 'main', htmlUrl: 'https://github.com/example/repo' },
  contextSha: '123456789', contextRef: 'main', nodes: [{ ...authoredFileFacts('complete'), id: 'file-1', path: 'src/index.ts', groupId: 'src', sourceIds: [] }], edges: [],
  groups: [{ id: 'src', label: 'Source' }], sources: [], coverage: { status: 'complete', reasons: [] }, createdAt: '2026-11-03T00:00:00Z', mode: 'demo',
};

describe('bounded memory storage', () => {
  let now: number;
  let store: SnapshotStore;
  const scope: StoreScope = { ownerId: 'alice', repository: 'Example/Repo' };
  beforeEach(async () => { now = Date.parse('2026-11-03T00:00:00Z'); store = await createStore({ databaseUrl: '', now: () => now, maxSnapshots: 2, maxJobs: 2, retentionMs: 60_000 }); });
  afterEach(async () => store.close());

  it('never returns another owner or repository snapshot and clones stored values', async () => {
    await store.putSnapshot(scope, snapshot);
    expect(await store.getSnapshot({ ...scope, ownerId: 'bob' }, snapshot.id)).toBeUndefined();
    expect(await store.getSnapshot({ ...scope, repository: 'other/repo' }, snapshot.id)).toBeUndefined();
    const loaded = await store.getSnapshot(scope, snapshot.id);
    loaded!.nodes[0]!.path = 'modified';
    expect((await store.getSnapshot(scope, snapshot.id))?.nodes[0]?.path).toBe('src/index.ts');
    expect(await store.getSnapshot({ ...scope, repository: 'example/repo' }, snapshot.id)).toBeDefined();
  });
  it('rejects mismatched repositories and invalid graph references', async () => {
    await expect(store.putSnapshot({ ...scope, repository: 'other/repo' }, snapshot)).rejects.toThrow('does not match');
    await expect(store.putSnapshot(scope, { ...snapshot, nodes: [{ ...snapshot.nodes[0]!, groupId: 'missing' }] })).rejects.toThrow();
  });
  it('loads latest by writes rather than LRU reads or caller dates and isolates scope', async () => {
    await store.putSnapshot(scope, { ...snapshot, id: 'older', createdAt: '2026-11-03T23:59:59Z' });
    await store.putSnapshot(scope, { ...snapshot, id: 'newer', createdAt: '2026-11-03T00:00:00Z' });
    await store.getSnapshot(scope, 'older');
    const latest = await store.getLatestSnapshot({ ...scope, repository: 'example/repo' });
    expect(latest?.id).toBe('newer'); latest!.nodes[0]!.path = 'changed';
    expect((await store.getLatestSnapshot(scope))?.nodes[0]!.path).toBe('src/index.ts');
    expect(await store.getLatestSnapshot({ ...scope, ownerId: 'bob' })).toBeUndefined();
    expect(await store.getLatestSnapshot({ ...scope, repository: 'other/repository' })).toBeUndefined();
    await store.putSnapshot(scope, { ...snapshot, id: 'older' }); expect((await store.getLatestSnapshot(scope))?.id).toBe('older');
    now += 60_001; expect(await store.getLatestSnapshot(scope)).toBeUndefined();
  });
  it('expires snapshots and jobs, with bounded snapshot LRU', async () => {
    await store.putSnapshot(scope, snapshot); await store.putSnapshot(scope, { ...snapshot, id: 'second' });
    await store.getSnapshot(scope, snapshot.id); await store.putSnapshot(scope, { ...snapshot, id: 'third' });
    expect(await store.getSnapshot(scope, 'second')).toBeUndefined();
    await store.putJob(scope, newJob({}, { now })); now += 60_001;
    expect(await store.getSnapshot(scope, snapshot.id)).toBeUndefined(); await store.prune();
  });
  it('leases jobs exclusively and rejects a stale worker after reclaim', async () => {
    const job = newJob({ repository: 'example/repo' }, { id: 'job-a', now }); await store.putJob(scope, job);
    const claims = await Promise.all([store.claimJob(scope, 'worker-a', 100), store.claimJob(scope, 'worker-b', 100)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.claimJob({ ...scope, ownerId: 'bob' }, 'worker-c')).toBeUndefined();
    now += 101; const reclaimed = await store.claimJob(scope, 'worker-c', 100);
    expect(reclaimed?.attempts).toBe(2);
    expect(await store.completeJob(scope, job.id, 'worker-a', { status: 'ready' })).toBe(false);
    expect(await store.completeJob(scope, job.id, 'worker-c', { status: 'ready', snapshotId: snapshot.id })).toBe(true);
    expect((await store.getJob(scope, job.id))?.snapshotId).toBe(snapshot.id);
  });
  it('renews only an unexpired owned lease', async () => {
    await store.putJob(scope, newJob({}, { id: 'renew', now })); await store.claimJob(scope, 'worker-a', 100);
    expect(await store.renewLease(scope, 'renew', 'other', 100)).toBe(false);
    expect(await store.renewLease(scope, 'renew', 'worker-a', 200)).toBe(true);
    now += 201; expect(await store.renewLease(scope, 'renew', 'worker-a', 100)).toBe(false);
  });
  it('cancellation wins over in-flight completion', async () => {
    await store.putJob(scope, newJob({}, { id: 'cancel', now })); await store.claimJob(scope, 'worker');
    expect(await store.cancelJob({ ...scope, ownerId: 'bob' }, 'cancel')).toBe(false);
    expect(await store.cancelJob(scope, 'cancel')).toBe(true);
    expect(await store.completeJob(scope, 'cancel', 'worker', { status: 'ready' })).toBe(false);
    expect(await store.claimJob(scope, 'next')).toBeUndefined();
    expect((await store.getJob(scope, 'cancel'))?.status).toBe('cancelled');
  });
  it('backs off retries and fails after the bounded attempt policy', async () => {
    await store.putJob(scope, newJob({}, { id: 'retry', maxAttempts: 2, now })); await store.claimJob(scope, 'worker');
    expect(await store.retryJob(scope, 'retry', 'worker', 'rate limited', 1_000)).toBe(true);
    expect(await store.claimJob(scope, 'worker')).toBeUndefined(); now += 1_001;
    expect((await store.claimJob(scope, 'worker'))?.attempts).toBe(2);
    await store.retryJob(scope, 'retry', 'worker', 'still failed');
    expect((await store.getJob(scope, 'retry'))?.status).toBe('failed');
    expect(await store.claimJob(scope, 'worker')).toBeUndefined();
  });
  it('recovers an abandoned final lease as failed', async () => {
    await store.putJob(scope, newJob({}, { id: 'abandoned', maxAttempts: 1, now })); await store.claimJob(scope, 'gone', 100); now += 101;
    expect(await store.claimJob(scope, 'replacement')).toBeUndefined(); expect((await store.getJob(scope, 'abandoned'))?.status).toBe('failed');
  });
  it('applies backpressure rather than silently dropping active jobs', async () => {
    await store.putJob(scope, newJob({}, { id: 'one', now })); await store.putJob(scope, newJob({}, { id: 'two', now }));
    await expect(store.putJob(scope, newJob({}, { id: 'three', now }))).rejects.toThrow('capacity');
    await store.cancelJob(scope, 'one'); await store.putJob(scope, newJob({}, { id: 'three', now })); expect(await store.getJob(scope, 'two')).toBeDefined();
  });
  it('preserves the job bound under concurrent insertions', async () => {
    const results = await Promise.allSettled(['one', 'two', 'three', 'four'].map((id) => store.putJob(scope, newJob({}, { id, now }))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(await store.getJob(scope, 'one')).toBeDefined(); expect(await store.getJob(scope, 'two')).toBeDefined();
  });
  it('deduplicates signed deliveries atomically and purges only the disconnected scope', async () => {
    expect(await Promise.all([store.recordWebhookDelivery(scope, 'delivery-1234'), store.recordWebhookDelivery(scope, 'delivery-1234')])).toEqual([true, false]);
    expect(await store.recordWebhookDelivery({ ...scope, ownerId: 'bob' }, 'delivery-1234')).toBe(true);
    await store.putSnapshot(scope, snapshot); await store.putSnapshot({ ...scope, ownerId: 'bob' }, snapshot);
    await store.deleteRepository(scope); expect(await store.getSnapshot(scope, snapshot.id)).toBeUndefined(); expect(await store.getSnapshot({ ...scope, ownerId: 'bob' }, snapshot.id)).toBeDefined();
    expect(await store.recordWebhookDelivery(scope, 'delivery-1234')).toBe(true);
  });
});

describe('GitHub webhook verification', () => {
  const secret = 'local-test-secret-at-least-sixteen-bytes';
  const raw = Buffer.from('{"repository":{"full_name":"example/repo"}}');
  const signed = (body = raw) => ({ signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, deliveryId: 'delivery-1234', event: 'push' });
  it('verifies exact raw bytes and parses only after signature validation', () => { expect(verifyWebhook(raw, signed(), secret).event).toBe('push'); expect(() => verifyWebhook(Buffer.from(raw.toString() + ' '), signed(), secret)).toThrow('signature'); });
  it('rejects malformed signatures, missing secret, oversized input and unsupported events', () => {
    expect(() => verifyWebhook(raw, { ...signed(), signature: 'sha256=aa' }, secret)).toThrow('signature');
    expect(() => verifyWebhook(raw, signed(), '')).toThrow('secret');
    expect(() => verifyWebhook(Buffer.alloc(1_048_577), signed(), secret)).toThrow('limit');
    expect(() => verifyWebhook(raw, { ...signed(), event: 'unknown' }, secret)).toThrow('Unsupported');
    expect(() => verifyWebhook(raw, { ...signed(), deliveryId: '../bad' }, secret)).toThrow('delivery');
  });
  it('accepts each validated delivery once', async () => {
    const store = await createStore({ databaseUrl: '' }); const webhook = verifyWebhook(raw, signed(), secret); const scope = { ownerId: 'installation-owner', repository: 'example/repo' };
    expect(await acceptWebhookDelivery(store, scope, webhook)).toEqual({ duplicate: false }); expect(await acceptWebhookDelivery(store, scope, webhook)).toEqual({ duplicate: true }); await store.close();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL persistence (opt-in isolated scope)', () => {
  it('persists across connections, isolates owners, atomically leases and rejects cancelled completion', async () => {
    const scope = { ownerId: `test-${randomUUID()}`, repository: 'example/repo' };
    const first = await createStore({ databaseUrl: process.env.TEST_DATABASE_URL });
    let second: SnapshotStore | undefined;
    try {
      await first.putSnapshot(scope, snapshot); await first.putJob(scope, newJob({}, { id: 'pg-job' }));
      second = await createStore({ databaseUrl: process.env.TEST_DATABASE_URL });
      expect((await second.getSnapshot(scope, snapshot.id))?.contextSha).toBe(snapshot.contextSha);
      expect(await second.getSnapshot({ ...scope, ownerId: 'outsider' }, snapshot.id)).toBeUndefined();
      await first.putSnapshot(scope, { ...snapshot, id: 'pg-latest', createdAt: '2026-01-01T00:00:00Z' });
      await first.getSnapshot(scope, snapshot.id);
      expect((await second.getLatestSnapshot(scope))?.id).toBe('pg-latest');
      expect(await second.getLatestSnapshot({ ...scope, ownerId: 'outsider' })).toBeUndefined();
      expect(await second.getLatestSnapshot({ ...scope, repository: 'foreign/repository' })).toBeUndefined();
      const claims = await Promise.all([first.claimJob(scope, 'one'), second.claimJob(scope, 'two')]); expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await first.cancelJob(scope, 'pg-job')).toBe(true);
      expect(await second.completeJob(scope, 'pg-job', claims[0]?.leaseOwner ?? claims[1]!.leaseOwner!, { status: 'ready' })).toBe(false);
      expect(await first.recordWebhookDelivery(scope, 'delivery-1234')).toBe(true); expect(await second.recordWebhookDelivery(scope, 'delivery-1234')).toBe(false);
      const same = newJob({ contextRef: 'a'.repeat(40) }, { id: 'idempotent' });
      const submitted = await Promise.all([first.enqueueJob(scope, same), second.enqueueJob(scope, same)]);
      expect(submitted.filter(result => result.created)).toHaveLength(1);
      expect((await first.listJobs(scope.ownerId)).map(entry => entry.job.id)).toContain('idempotent');
      expect(await first.listJobs('unrelated-owner')).toEqual([]);
      await first.enqueueJob(scope, newJob({}, { id: 'second-active' })); await first.enqueueJob(scope, newJob({}, { id: 'third-active' }));
      expect(await first.claimJob(scope, 'owner-one', 30_000, 'idempotent')).toBeDefined();
      expect(await second.claimJob(scope, 'owner-two', 30_000, 'second-active')).toBeDefined();
      expect(await first.claimJob(scope, 'owner-three', 30_000, 'third-active')).toBeUndefined();
      expect(await first.updateJobProgress(scope, 'idempotent', 'owner-one', { status: 'indexing', progress: 70, message: 'Indexing' })).toBe(true);
      expect(await second.updateJobProgress(scope, 'idempotent', 'owner-one', { status: 'fetching', progress: 3, message: 'Retry' })).toBe(true);
      expect((await first.getJob(scope, 'idempotent'))?.progress).toBe(70);
      expect(await second.updateJobProgress(scope, 'idempotent', 'wrong-worker', { status: 'grouping', progress: 99, message: 'Forged' })).toBe(false);
    } finally { await first.deleteRepository(scope); await first.close(); await second?.close(); }
  });
});
