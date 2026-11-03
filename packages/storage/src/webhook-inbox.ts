import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import type { StoreScope } from './index.js';

/** Stored webhook metadata deliberately excludes raw payloads, source text and tokens. */
export interface RefreshTask {
  scope: StoreScope;
  installationId: number;
  repositoryId: number;
  contextRef?: string;
  refreshVersion?: string;
  kind: 'refresh' | 'revoke';
  reason: 'push' | 'pull_request' | 'installation_deleted' | 'repository_removed' | 'reconcile';
}
export interface WebhookEnvelope { deliveryId: string; tasks: RefreshTask[]; createdAt: string }
export interface LeasedWebhook extends WebhookEnvelope { lease: string; attempts: number }
export interface RefreshState {
  repository: string;
  revision: number;
  stale: boolean;
  revoked: boolean;
  reason: RefreshTask['reason'];
  updatedAt: string;
  jobId?: string;
}
export interface WebhookInbox {
  readonly durable: boolean;
  enqueue(envelope: WebhookEnvelope): Promise<boolean>;
  claim(): Promise<LeasedWebhook | undefined>;
  renew(delivery: LeasedWebhook): Promise<boolean>;
  finish(delivery: LeasedWebhook): Promise<void>;
  retry(delivery: LeasedWebhook): Promise<void>;
  mark(task: RefreshTask, jobId?: string): Promise<RefreshState>;
  state(scope: StoreScope): Promise<RefreshState | undefined>;
  close(): Promise<void>;
}
function key(scope: StoreScope) { return JSON.stringify([scope.ownerId, scope.repository.toLowerCase()]); }
function checked(envelope: WebhookEnvelope): WebhookEnvelope {
  if (!/^[A-Za-z0-9-]{8,100}$/.test(envelope.deliveryId) || !Number.isFinite(Date.parse(envelope.createdAt)) || envelope.tasks.length > 1000) throw new Error('Invalid webhook envelope');
  for (const task of envelope.tasks) {
    if (!task.scope.ownerId || task.scope.ownerId.length > 200 || /[\u0000-\u001f]/.test(task.scope.ownerId) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task.scope.repository) || !Number.isSafeInteger(task.installationId) || task.installationId < 1 || !Number.isSafeInteger(task.repositoryId) || task.repositoryId < 1 || !['refresh', 'revoke'].includes(task.kind)) throw new Error('Invalid webhook task');
  }
  if (Buffer.byteLength(JSON.stringify(envelope)) > 512_000) throw new Error('Webhook envelope exceeds budget');
  return structuredClone(envelope);
}

/** Deterministic test/local-only fallback. Configured webhook ingress requires durable=true. */
export class MemoryWebhookInbox implements WebhookInbox {
  readonly durable: boolean = false;
  private entries = new Map<string, { value: WebhookEnvelope; expires: number; state: 'queued' | 'running' | 'done'; lease?: string; leaseUntil?: number; available: number; attempts: number }>();
  private states = new Map<string, RefreshState>();
  constructor(private readonly options: { now?: () => number; maxEntries?: number; retentionMs?: number } = {}) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  async enqueue(value: WebhookEnvelope) {
    value = checked(value); const now = this.now();
    for (const [id, entry] of this.entries) if (entry.expires <= now && (entry.state !== 'running' || (entry.leaseUntil ?? 0) <= now)) this.entries.delete(id);
    if (this.entries.has(value.deliveryId)) return false;
    if (this.entries.size >= (this.options.maxEntries ?? 10_000)) throw Object.assign(new Error('Webhook inbox is full; redeliver later.'), { status: 503 });
    this.entries.set(value.deliveryId, { value, expires: now + (this.options.retentionMs ?? 604_800_000), state: 'queued', available: now, attempts: 0 }); return true;
  }
  async claim(): Promise<LeasedWebhook | undefined> {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.state === 'done' || entry.available > now || (entry.state === 'running' && (entry.leaseUntil ?? 0) > now)) continue;
      if (entry.attempts >= 10) { entry.state = 'done'; continue; }
      entry.state = 'running'; entry.lease = randomUUID(); entry.leaseUntil = now + 60_000; entry.attempts++;
      return { ...structuredClone(entry.value), lease: entry.lease, attempts: entry.attempts };
    }
    return undefined;
  }
  async finish(value: LeasedWebhook) { const entry = this.entries.get(value.deliveryId); if (entry?.lease === value.lease) { entry.state = 'done'; delete entry.lease; } }
  async renew(value: LeasedWebhook) { const entry = this.entries.get(value.deliveryId); if (entry?.lease !== value.lease || (entry.leaseUntil ?? 0) <= this.now()) return false; entry.leaseUntil = this.now() + 60_000; return true; }
  async retry(value: LeasedWebhook) { const entry = this.entries.get(value.deliveryId); if (entry?.lease === value.lease) { entry.state = 'queued'; entry.available = this.now() + Math.min(300_000, 1000 * 2 ** Math.min(value.attempts - 1, 8)); delete entry.lease; } }
  async mark(task: RefreshTask, jobId?: string) {
    const id = key(task.scope), previous = this.states.get(id);
    const state: RefreshState = { repository: task.scope.repository.toLowerCase(), revision: (previous?.revision ?? 0) + 1, stale: true, revoked: task.kind === 'revoke', reason: task.reason, updatedAt: new Date(this.now()).toISOString(), ...(jobId ? { jobId } : {}) };
    // State is bounded with the delivery corpus; authorize/reconcile can recreate it.
    if (!this.states.has(id) && this.states.size >= (this.options.maxEntries ?? 10_000)) this.states.delete(this.states.keys().next().value!);
    this.states.set(id, state); return structuredClone(state);
  }
  async state(scope: StoreScope) { const value = this.states.get(key(scope)); return value ? structuredClone(value) : undefined; }
  async close() {}
}

/** PostgreSQL inbox/outbox: insertion and replay identity are one atomic durable write. */
export class PostgresWebhookInbox implements WebhookInbox {
  readonly durable = true;
  private closePromise?: Promise<void>;
  constructor(private readonly pool: Pool, private readonly options: { maxEntries?: number; retentionMs?: number; ownsPool?: boolean } = {}) {}
  async enqueue(input: WebhookEnvelope) {
    const value = checked(input), client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize the bounded-capacity decision, including across BFF instances.
      await client.query("SELECT pg_advisory_xact_lock(173124908, 20)");
      await client.query("DELETE FROM patchwork_webhook_inbox WHERE expires_at < now() AND (status <> 'running' OR lease_until < now())");
      await client.query('DELETE FROM patchwork_refresh_state WHERE expires_at < now()');
      const previous = await client.query('SELECT delivery_id FROM patchwork_webhook_inbox WHERE delivery_id=$1', [value.deliveryId]);
      if (previous.rowCount) { await client.query('COMMIT'); return false; }
      const count = await client.query<{ count: string }>('SELECT count(*) FROM patchwork_webhook_inbox');
      if (Number(count.rows[0]?.count) >= (this.options.maxEntries ?? 10_000)) throw Object.assign(new Error('Webhook inbox is full; redeliver later.'), { status: 503 });
      await client.query('INSERT INTO patchwork_webhook_inbox(delivery_id,payload,expires_at) VALUES($1,$2,now()+$3::bigint*interval \'1 millisecond\')', [value.deliveryId, value, this.options.retentionMs ?? 604_800_000]);
      await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async claim(): Promise<LeasedWebhook | undefined> {
    const lease = randomUUID();
    await this.pool.query("UPDATE patchwork_webhook_inbox SET status='failed',lease=NULL,lease_until=NULL WHERE status='running' AND lease_until < now() AND attempts >= 10");
    const result = await this.pool.query<{ payload: WebhookEnvelope; attempts: number }>(`WITH candidate AS (
      SELECT delivery_id FROM patchwork_webhook_inbox WHERE status IN ('queued','running') AND available_at <= now() AND (lease_until IS NULL OR lease_until < now()) AND attempts < 10 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE patchwork_webhook_inbox i SET status='running',lease=$1,lease_until=now()+interval '60 seconds',attempts=attempts+1 FROM candidate c WHERE i.delivery_id=c.delivery_id RETURNING i.payload,i.attempts`, [lease]);
    const row = result.rows[0]; return row ? { ...checked(row.payload), lease, attempts: row.attempts } : undefined;
  }
  async finish(value: LeasedWebhook) { await this.pool.query("UPDATE patchwork_webhook_inbox SET status='done',lease=NULL,lease_until=NULL WHERE delivery_id=$1 AND lease=$2", [value.deliveryId, value.lease]); }
  async renew(value: LeasedWebhook) { const result = await this.pool.query("UPDATE patchwork_webhook_inbox SET lease_until=now()+interval '60 seconds' WHERE delivery_id=$1 AND lease=$2 AND lease_until > now() AND status='running'", [value.deliveryId, value.lease]); return result.rowCount === 1; }
  async retry(value: LeasedWebhook) { await this.pool.query("UPDATE patchwork_webhook_inbox SET status=CASE WHEN attempts >= 10 THEN 'failed' ELSE 'queued' END,lease=NULL,lease_until=NULL,available_at=now()+$3::bigint*interval '1 millisecond' WHERE delivery_id=$1 AND lease=$2", [value.deliveryId, value.lease, Math.min(300_000, 1000 * 2 ** Math.min(value.attempts - 1, 8))]); }
  async mark(task: RefreshTask, jobId?: string): Promise<RefreshState> {
    const result = await this.pool.query<{ payload: RefreshState }>(`INSERT INTO patchwork_refresh_state(owner_id,repository,revision,payload,expires_at) VALUES($1,$2,1,$3,now()+interval '7 days')
      ON CONFLICT(owner_id,repository) DO UPDATE SET revision=patchwork_refresh_state.revision+1,payload=$3,expires_at=now()+interval '7 days'
      RETURNING payload || jsonb_build_object('revision',revision) AS payload`, [task.scope.ownerId, task.scope.repository.toLowerCase(), { repository: task.scope.repository.toLowerCase(), stale: true, revoked: task.kind === 'revoke', reason: task.reason, updatedAt: new Date().toISOString(), ...(jobId ? { jobId } : {}) }]);
    return result.rows[0]!.payload;
  }
  async state(scope: StoreScope): Promise<RefreshState | undefined> { const value = await this.pool.query<{ payload: RefreshState }>("SELECT payload || jsonb_build_object('revision',revision) AS payload FROM patchwork_refresh_state WHERE owner_id=$1 AND repository=$2 AND expires_at > now()", [scope.ownerId, scope.repository.toLowerCase()]); return value.rows[0]?.payload; }
  async close() { if (this.options.ownsPool) { this.closePromise ??= this.pool.end(); await this.closePromise; } }
}

export async function createPostgresWebhookInbox(config: { databaseUrl: string; autoMigrate?: boolean; maxEntries?: number; retentionMs?: number }): Promise<WebhookInbox> {
  if (!config.databaseUrl) throw new Error('Webhook durability requires DATABASE_URL.');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: config.databaseUrl, max: 3, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, statement_timeout: 10_000 });
  try {
    if (config.autoMigrate !== false) {
      const sql = await readFile(new URL('../../../database/migrations/002_webhook_inbox.sql', import.meta.url), 'utf8');
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(173124908,20)'); await client.query(sql); await client.query('COMMIT'); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } else await pool.query('SELECT 1 FROM patchwork_webhook_inbox LIMIT 1');
    return new PostgresWebhookInbox(pool, { maxEntries: config.maxEntries, retentionMs: config.retentionMs, ownsPool: true });
  } catch (error) { await pool.end(); throw error; }
}
