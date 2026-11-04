import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateGraphSnapshot, type GraphSnapshot } from '@patchwork/contracts';
import type { Pool as PgPool, PoolClient } from 'pg';

export interface StoreScope { ownerId: string; repository: string }
export type JobStatus = 'queued' | 'fetching' | 'indexing' | 'grouping' | 'ready' | 'partial' | 'failed' | 'cancelled';
export interface StoredJob {
  id: string;
  status: JobStatus;
  progress: number;
  input: Record<string, unknown>;
  snapshotId?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
}
export interface StoreConfig {
  databaseUrl?: string;
  autoMigrate?: boolean;
  maxSnapshots?: number;
  maxJobs?: number;
  maxDeliveries?: number;
  retentionMs?: number;
  /** Serialized snapshot ceiling in bytes. Defaults to 16 MiB; at most 64 MiB. */
  maxSnapshotBytes?: number;
  /** Ceiling for `local-git` snapshots only (registered local mirrors). Defaults to maxSnapshotBytes; at most 64 MiB. */
  maxLocalSnapshotBytes?: number;
  /** Inject a clock for deterministic lease/expiry tests. */
  now?: () => number;
}
export interface SnapshotStore {
  readonly kind: 'memory' | 'postgres';
  putSnapshot(scope: StoreScope, snapshot: GraphSnapshot): Promise<void>;
  getSnapshot(scope: StoreScope, id: string): Promise<GraphSnapshot | undefined>;
  /** Most recently written unexpired snapshot in this exact owner/repository scope. */
  getLatestSnapshot(scope: StoreScope): Promise<GraphSnapshot | undefined>;
  /** All retained repository scopes, including expired data awaiting pruning. */
  listRepositories(ownerId: string): Promise<string[]>;
  deleteRepository(scope: StoreScope): Promise<void>;
  putJob(scope: StoreScope, job: StoredJob): Promise<void>;
  /** Atomic insert without replacing an existing idempotency key. */
  enqueueJob(scope: StoreScope, job: StoredJob): Promise<{ job: StoredJob; created: boolean }>;
  /** Recovery discovery is explicitly owner-scoped and bounded. */
  listJobs(ownerId: string, limit?: number): Promise<{ scope: StoreScope; job: StoredJob }[]>;
  getJob(scope: StoreScope, id: string): Promise<StoredJob | undefined>;
  /** Lease only jobs in this caller's scope; expired leases may be reclaimed. */
  claimJob(scope: StoreScope, workerId: string, leaseMs?: number, id?: string): Promise<StoredJob | undefined>;
  updateJobProgress(scope: StoreScope, id: string, workerId: string, update: { status: 'fetching' | 'indexing' | 'grouping'; progress: number; message: string }): Promise<boolean>;
  renewLease(scope: StoreScope, id: string, workerId: string, leaseMs?: number): Promise<boolean>;
  completeJob(scope: StoreScope, id: string, workerId: string, result: { snapshotId?: string; status: 'ready' | 'partial' | 'failed'; error?: string; errorCode?: string; retryable?: boolean }): Promise<boolean>;
  retryJob(scope: StoreScope, id: string, workerId: string, error: string, delayMs?: number): Promise<boolean>;
  cancelJob(scope: StoreScope, id: string): Promise<boolean>;
  /** Atomic insert; true is the first delivery, false is a replay. Call after signature verification. */
  recordWebhookDelivery(scope: StoreScope, deliveryId: string): Promise<boolean>;
  prune(): Promise<void>;
  close(): Promise<void>;
}

const terminal = new Set<JobStatus>(['ready', 'partial', 'failed', 'cancelled']);
const states = new Set<JobStatus>(['queued', 'fetching', 'indexing', 'grouping', 'ready', 'partial', 'failed', 'cancelled']);
function normalizeScope(scope: StoreScope): StoreScope {
  if (!scope || typeof scope.ownerId !== 'string' || scope.ownerId.length < 1 || scope.ownerId.length > 200 || /[\u0000-\u001f]/.test(scope.ownerId)) throw new Error('Invalid storage owner scope');
  if (typeof scope.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.repository) || scope.repository.length > 300) throw new Error('Invalid storage repository scope');
  return { ownerId: scope.ownerId, repository: scope.repository.toLowerCase() };
}
function validateId(id: string): void { if (typeof id !== 'string' || !id || id.length > 500 || /[\u0000-\u001f]/.test(id)) throw new Error('Invalid storage ID'); }
function checkedJob(job: StoredJob): StoredJob {
  validateId(job.id);
  if (!states.has(job.status) || !Number.isFinite(job.progress) || job.progress < 0 || job.progress > 100) throw new Error('Invalid job status/progress');
  if (!Number.isInteger(job.attempts) || job.attempts < 0 || !Number.isInteger(job.maxAttempts) || job.maxAttempts < 1 || job.maxAttempts > 20 || job.attempts > job.maxAttempts) throw new Error('Invalid job attempt policy');
  for (const date of [job.createdAt, job.updatedAt, job.availableAt, ...(job.leaseExpiresAt ? [job.leaseExpiresAt] : [])]) if (!Number.isFinite(Date.parse(date))) throw new Error('Invalid job date');
  if (!job.input || typeof job.input !== 'object' || Array.isArray(job.input)) throw new Error('Invalid job input');
  if (Buffer.byteLength(JSON.stringify(job)) > 1_048_576) throw new Error('Job exceeds 1 MiB storage limit');
  return structuredClone(job);
}
export const DEFAULT_MAX_SNAPSHOT_BYTES = 16_777_216;
export const MAX_SNAPSHOT_BYTES_CEILING = 67_108_864;
interface SnapshotCeilings { other: number; local: number; }
function snapshotCeilings(config: StoreConfig): SnapshotCeilings {
  const other = bounded(config.maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_BYTES_CEILING);
  return { other, local: bounded(config.maxLocalSnapshotBytes, other, MAX_SNAPSHOT_BYTES_CEILING) };
}
/** A raised local ceiling never applies to GitHub or demo snapshots. */
function checkedSnapshot(snapshot: GraphSnapshot, ceilings: SnapshotCeilings = { other: DEFAULT_MAX_SNAPSHOT_BYTES, local: DEFAULT_MAX_SNAPSHOT_BYTES }): GraphSnapshot {
  const maxBytes = snapshot.mode === 'local-git' ? ceilings.local : ceilings.other;
  if (Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes) throw Object.assign(new Error(`Snapshot exceeds ${Math.round(maxBytes / 1_048_576)} MiB storage limit`), { status: 413, code: 'SNAPSHOT_LIMIT' });
  return validateGraphSnapshot(snapshot);
}
function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1 || value > max) throw new Error('Invalid storage bound');
  return Math.floor(value);
}
export function newJob(input: Record<string, unknown>, options: { id?: string; maxAttempts?: number; now?: number } = {}): StoredJob {
  const timestamp = new Date(options.now ?? Date.now()).toISOString();
  return checkedJob({ id: options.id ?? randomUUID(), input, status: 'queued', progress: 0, createdAt: timestamp, updatedAt: timestamp, availableAt: timestamp, attempts: 0, maxAttempts: options.maxAttempts ?? 3 });
}

class MemoryStore implements SnapshotStore {
  readonly kind = 'memory' as const;
  private snapshots = new Map<string, { scope: StoreScope; value: GraphSnapshot; expires: number; storedOrder: number }>();
  private snapshotWriteOrder = 0;
  private jobs = new Map<string, { scope: StoreScope; value: StoredJob; expires: number }>();
  private deliveries = new Map<string, number>();
  private readonly now: () => number;
  private readonly retention: number;
  private readonly maxSnapshots: number;
  private readonly maxJobs: number;
  private readonly maxDeliveries: number;
  private readonly snapshotCeilings: SnapshotCeilings;
  constructor(config: StoreConfig) {
    this.now = config.now ?? Date.now;
    this.retention = bounded(config.retentionMs, 86_400_000, 2_592_000_000);
    this.maxSnapshots = bounded(config.maxSnapshots, 100, 100_000);
    this.maxJobs = bounded(config.maxJobs, 500, 100_000);
    this.maxDeliveries = bounded(config.maxDeliveries, 5_000, 1_000_000);
    this.snapshotCeilings = snapshotCeilings(config);
  }
  private key(scope: StoreScope, id: string): string { const s = normalizeScope(scope); validateId(id); return JSON.stringify([s.ownerId, s.repository, id]); }
  private trim<T>(map: Map<string, T>, max: number): void { while (map.size > max) { const key = map.keys().next().value; if (key !== undefined) map.delete(key); } }
  async putSnapshot(scope: StoreScope, snapshot: GraphSnapshot): Promise<void> {
    snapshot = checkedSnapshot(snapshot, this.snapshotCeilings);
    const s = normalizeScope(scope); if (snapshot.repository.fullName.toLowerCase() !== s.repository) throw new Error('Snapshot repository does not match scope');
    const key = this.key(s, snapshot.id); this.snapshots.delete(key); this.snapshots.set(key, { scope: s, value: structuredClone(snapshot), expires: this.now() + this.retention, storedOrder: ++this.snapshotWriteOrder }); this.trim(this.snapshots, this.maxSnapshots);
  }
  async getSnapshot(scope: StoreScope, id: string): Promise<GraphSnapshot | undefined> {
    const key = this.key(scope, id), entry = this.snapshots.get(key); if (!entry) return undefined;
    if (entry.expires <= this.now()) { this.snapshots.delete(key); return undefined; }
    this.snapshots.delete(key); this.snapshots.set(key, entry); return structuredClone(entry.value);
  }
  async getLatestSnapshot(scope: StoreScope): Promise<GraphSnapshot | undefined> {
    const selected = normalizeScope(scope);
    let latest: { value: GraphSnapshot; storedOrder: number } | undefined;
    for (const entry of this.snapshots.values()) if (entry.scope.ownerId === selected.ownerId && entry.scope.repository === selected.repository && entry.expires > this.now() && (!latest || entry.storedOrder > latest.storedOrder)) latest = entry;
    return latest ? structuredClone(latest.value) : undefined;
  }
  async listRepositories(ownerId: string): Promise<string[]> {
    normalizeScope({ ownerId, repository: 'scope/check' });
    const repositories = new Set<string>();
    for (const entry of [...this.snapshots.values(), ...this.jobs.values()]) if (entry.scope.ownerId === ownerId) repositories.add(entry.scope.repository);
    for (const key of this.deliveries.keys()) { const tuple = JSON.parse(key) as string[]; if (tuple[0] === ownerId) repositories.add(tuple[1]!); }
    return [...repositories].sort();
  }
  async putJob(scope: StoreScope, job: StoredJob): Promise<void> {
    const s = normalizeScope(scope), value = checkedJob(job); const key = this.key(s, job.id);
    if (!this.jobs.has(key) && this.jobs.size >= this.maxJobs) {
      this.pruneExpired();
      const evictable = [...this.jobs].find(([, entry]) => terminal.has(entry.value.status));
      if (this.jobs.size >= this.maxJobs && evictable) this.jobs.delete(evictable[0]);
      if (this.jobs.size >= this.maxJobs) throw new Error('Job capacity reached; retry after an active job completes');
    }
    this.jobs.delete(key); this.jobs.set(key, { scope: s, value, expires: this.now() + this.retention }); this.trim(this.jobs, this.maxJobs);
  }
  async getJob(scope: StoreScope, id: string): Promise<StoredJob | undefined> {
    const key = this.key(scope, id), entry = this.jobs.get(key); if (!entry) return undefined;
    if (entry.expires <= this.now()) { this.jobs.delete(key); return undefined; } return structuredClone(entry.value);
  }
  async enqueueJob(scope: StoreScope, job: StoredJob): Promise<{ job: StoredJob; created: boolean }> {
    const entry = this.jobs.get(this.key(scope, job.id));
    if (entry && entry.expires > this.now() && !['failed', 'cancelled'].includes(entry.value.status)) return { job: structuredClone(entry.value), created: false };
    // No await between capacity validation/insertion: competing local submissions cannot overwrite.
    await this.putJob(scope, job); return { job: structuredClone(job), created: true };
  }
  async listJobs(ownerId: string, limit = 100): Promise<{ scope: StoreScope; job: StoredJob }[]> {
    normalizeScope({ ownerId, repository: 'scope/check' }); limit = bounded(limit, 100, 100);
    return [...this.jobs.values()].filter(entry => entry.scope.ownerId === ownerId && entry.expires > this.now() && !terminal.has(entry.value.status)).slice(0, limit).map(entry => ({ scope: structuredClone(entry.scope), job: structuredClone(entry.value) }));
  }
  async claimJob(scope: StoreScope, workerId: string, leaseMs = 30_000, id?: string): Promise<StoredJob | undefined> {
    const s = normalizeScope(scope); validateId(workerId); leaseMs = bounded(leaseMs, 30_000, 3_600_000); const now = this.now();
    for (const entry of this.jobs.values()) {
      const job = entry.value;
      if ((id && job.id !== id) || entry.scope.ownerId !== s.ownerId || entry.scope.repository !== s.repository || entry.expires <= now || terminal.has(job.status) || Date.parse(job.availableAt) > now || (job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > now)) continue;
      if (job.attempts >= job.maxAttempts) { job.status = 'failed'; job.error = 'Maximum attempts reached'; job.updatedAt = new Date(now).toISOString(); continue; }
      job.status = 'fetching'; job.attempts++; job.leaseOwner = workerId; job.leaseExpiresAt = new Date(now + leaseMs).toISOString(); job.updatedAt = new Date(now).toISOString(); return structuredClone(job);
    }
    return undefined;
  }
  private leased(scope: StoreScope, id: string, worker: string): StoredJob | undefined {
    const entry = this.jobs.get(this.key(scope, id)); const job = entry?.value;
    return entry && entry.expires > this.now() && job && !terminal.has(job.status) && job.leaseOwner === worker && job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > this.now() ? job : undefined;
  }
  async updateJobProgress(scope: StoreScope, id: string, workerId: string, update: { status: 'fetching' | 'indexing' | 'grouping'; progress: number; message: string }): Promise<boolean> {
    const job = this.leased(scope, id, workerId); if (!job) return false;
    if (!['fetching', 'indexing', 'grouping'].includes(update.status) || !Number.isFinite(update.progress)) throw new Error('Invalid job progress');
    job.progress = Math.max(job.progress, Math.min(99, Math.max(0, update.progress))); job.status = update.status;
    job.input.progressMessage = update.message.slice(0, 500); job.updatedAt = new Date(this.now()).toISOString(); return true;
  }
  async renewLease(scope: StoreScope, id: string, workerId: string, leaseMs = 30_000): Promise<boolean> {
    const job = this.leased(scope, id, workerId); if (!job) return false; job.leaseExpiresAt = new Date(this.now() + bounded(leaseMs, 30_000, 3_600_000)).toISOString(); job.updatedAt = new Date(this.now()).toISOString(); return true;
  }
  async completeJob(scope: StoreScope, id: string, workerId: string, result: { snapshotId?: string; status: 'ready' | 'partial' | 'failed'; error?: string; errorCode?: string; retryable?: boolean }): Promise<boolean> {
    const job = this.leased(scope, id, workerId); if (!job) return false;
    job.status = result.status; if (result.status !== 'failed') job.progress = 100; job.snapshotId = result.snapshotId; job.error = result.error?.slice(0, 2_000); job.errorCode = result.errorCode; job.retryable = result.retryable; job.leaseOwner = undefined; job.leaseExpiresAt = undefined; job.updatedAt = new Date(this.now()).toISOString(); return true;
  }
  async retryJob(scope: StoreScope, id: string, workerId: string, error: string, delayMs = 1_000): Promise<boolean> {
    const job = this.leased(scope, id, workerId); if (!job) return false;
    job.status = job.attempts >= job.maxAttempts ? 'failed' : 'queued'; job.error = error.slice(0, 2_000); job.errorCode = 'RETRYABLE_ANALYSIS'; job.retryable = true; job.availableAt = new Date(this.now() + Math.max(0, Math.min(delayMs, 3_600_000))).toISOString(); job.leaseOwner = undefined; job.leaseExpiresAt = undefined; job.updatedAt = new Date(this.now()).toISOString(); return true;
  }
  async cancelJob(scope: StoreScope, id: string): Promise<boolean> {
    const entry = this.jobs.get(this.key(scope, id)); if (!entry || entry.expires <= this.now() || terminal.has(entry.value.status)) return false;
    Object.assign(entry.value, { status: 'cancelled', updatedAt: new Date(this.now()).toISOString(), leaseOwner: undefined, leaseExpiresAt: undefined }); return true;
  }
  async recordWebhookDelivery(scope: StoreScope, deliveryId: string): Promise<boolean> {
    const key = this.key(scope, deliveryId), expiry = this.deliveries.get(key); if (expiry && expiry > this.now()) return false;
    this.deliveries.delete(key); this.deliveries.set(key, this.now() + this.retention); this.trim(this.deliveries, this.maxDeliveries); return true;
  }
  async deleteRepository(scope: StoreScope): Promise<void> {
    const s = normalizeScope(scope); for (const [key, entry] of this.snapshots) if (entry.scope.ownerId === s.ownerId && entry.scope.repository === s.repository) this.snapshots.delete(key);
    for (const [key, entry] of this.jobs) if (entry.scope.ownerId === s.ownerId && entry.scope.repository === s.repository) this.jobs.delete(key);
    for (const key of this.deliveries.keys()) { const tuple = JSON.parse(key) as string[]; if (tuple[0] === s.ownerId && tuple[1] === s.repository) this.deliveries.delete(key); }
  }
  private pruneExpired(): void { const now = this.now(); for (const [key, item] of this.snapshots) if (item.expires <= now) this.snapshots.delete(key); for (const [key, item] of this.jobs) if (item.expires <= now) this.jobs.delete(key); for (const [key, expiry] of this.deliveries) if (expiry <= now) this.deliveries.delete(key); }
  async prune(): Promise<void> { this.pruneExpired(); }
  async close(): Promise<void> { this.snapshots.clear(); this.jobs.clear(); this.deliveries.clear(); }
}

class PostgresStore implements SnapshotStore {
  readonly kind = 'postgres' as const;
  constructor(private pool: PgPool, private retention: number, private snapshotCeilings: SnapshotCeilings = { other: DEFAULT_MAX_SNAPSHOT_BYTES, local: DEFAULT_MAX_SNAPSHOT_BYTES }) {}
  private params(scope: StoreScope): [string, string] { const s = normalizeScope(scope); return [s.ownerId, s.repository]; }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> { const client = await this.pool.connect(); try { await client.query('BEGIN'); const value = await run(client); await client.query('COMMIT'); return value; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async putSnapshot(scope: StoreScope, snapshot: GraphSnapshot): Promise<void> {
    snapshot = checkedSnapshot(snapshot, this.snapshotCeilings);
    const p = this.params(scope); validateId(snapshot.id); if (snapshot.repository.fullName.toLowerCase() !== p[1]) throw new Error('Snapshot repository does not match scope');
    await this.pool.query('INSERT INTO patchwork_snapshots(owner_id, repository, id, payload, expires_at, stored_at) VALUES($1,$2,$3,$4::jsonb,NOW()+$5*INTERVAL \'1 millisecond\',clock_timestamp()) ON CONFLICT(owner_id,repository,id) DO UPDATE SET payload=EXCLUDED.payload, expires_at=EXCLUDED.expires_at, stored_at=EXCLUDED.stored_at', [...p, snapshot.id, JSON.stringify(snapshot), this.retention]);
  }
  async getSnapshot(scope: StoreScope, id: string): Promise<GraphSnapshot | undefined> { validateId(id); const r = await this.pool.query<{ payload: GraphSnapshot }>('SELECT payload FROM patchwork_snapshots WHERE owner_id=$1 AND repository=$2 AND id=$3 AND expires_at>NOW()', [...this.params(scope), id]); return r.rows[0]?.payload; }
  async getLatestSnapshot(scope: StoreScope): Promise<GraphSnapshot | undefined> {
    const result = await this.pool.query<{ payload: GraphSnapshot }>('SELECT payload FROM patchwork_snapshots WHERE owner_id=$1 AND repository=$2 AND expires_at>NOW() ORDER BY stored_at DESC,id DESC LIMIT 1', this.params(scope));
    return result.rows[0]?.payload;
  }
  async listRepositories(ownerId: string): Promise<string[]> {
    normalizeScope({ ownerId, repository: 'scope/check' });
    const result = await this.pool.query<{ repository: string }>('SELECT repository FROM patchwork_snapshots WHERE owner_id=$1 UNION SELECT repository FROM patchwork_jobs WHERE owner_id=$1 UNION SELECT repository FROM patchwork_webhook_deliveries WHERE owner_id=$1 ORDER BY repository', [ownerId]);
    return result.rows.map(row => row.repository);
  }
  async putJob(scope: StoreScope, job: StoredJob): Promise<void> {
    const j = checkedJob(job); await this.pool.query('INSERT INTO patchwork_jobs(owner_id,repository,id,payload,status,available_at,lease_owner,lease_expires_at,attempts,max_attempts,expires_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,NOW()+$11*INTERVAL \'1 millisecond\') ON CONFLICT(owner_id,repository,id) DO UPDATE SET payload=EXCLUDED.payload,status=EXCLUDED.status,available_at=EXCLUDED.available_at,lease_owner=EXCLUDED.lease_owner,lease_expires_at=EXCLUDED.lease_expires_at,attempts=EXCLUDED.attempts,max_attempts=EXCLUDED.max_attempts,expires_at=EXCLUDED.expires_at', [...this.params(scope), j.id, JSON.stringify(j), j.status, j.availableAt, j.leaseOwner ?? null, j.leaseExpiresAt ?? null, j.attempts, j.maxAttempts, this.retention]);
  }
  async getJob(scope: StoreScope, id: string): Promise<StoredJob | undefined> { validateId(id); const r = await this.pool.query<{ payload: StoredJob }>('SELECT payload FROM patchwork_jobs WHERE owner_id=$1 AND repository=$2 AND id=$3 AND expires_at>NOW()', [...this.params(scope), id]); return r.rows[0]?.payload; }
  async enqueueJob(scope: StoreScope, job: StoredJob): Promise<{ job: StoredJob; created: boolean }> {
    const j = checkedJob(job), p = this.params(scope);
    return this.transaction(async client => {
      // Serialize submissions for one owner so queue capacity and idempotency are atomic.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [p[0]]);
      const existing = await client.query<{ payload: StoredJob }>('SELECT payload FROM patchwork_jobs WHERE owner_id=$1 AND repository=$2 AND id=$3 AND expires_at>NOW()', [...p, j.id]);
      if (existing.rows[0] && !['failed', 'cancelled'].includes(existing.rows[0].payload.status)) return { job: existing.rows[0].payload, created: false };
      const count = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM patchwork_jobs WHERE owner_id=$1 AND expires_at>NOW() AND status NOT IN ('ready','partial','failed','cancelled')", [p[0]]);
      if (Number(count.rows[0]?.count) >= 100) throw new Error('Durable job capacity reached');
      await client.query('INSERT INTO patchwork_jobs(owner_id,repository,id,payload,status,available_at,attempts,max_attempts,expires_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,NOW()+$9*INTERVAL \'1 millisecond\') ON CONFLICT(owner_id,repository,id) DO UPDATE SET payload=EXCLUDED.payload,status=EXCLUDED.status,available_at=EXCLUDED.available_at,lease_owner=NULL,lease_expires_at=NULL,attempts=EXCLUDED.attempts,max_attempts=EXCLUDED.max_attempts,expires_at=EXCLUDED.expires_at WHERE patchwork_jobs.expires_at<=NOW() OR patchwork_jobs.status IN (\'failed\',\'cancelled\')', [...p, j.id, JSON.stringify(j), j.status, j.availableAt, j.attempts, j.maxAttempts, this.retention]);
      return { job: j, created: true };
    });
  }
  async listJobs(ownerId: string, limit = 100): Promise<{ scope: StoreScope; job: StoredJob }[]> {
    normalizeScope({ ownerId, repository: 'scope/check' });
    const result = await this.pool.query<{ repository: string; payload: StoredJob }>("SELECT repository,payload FROM patchwork_jobs WHERE owner_id=$1 AND expires_at>NOW() AND status NOT IN ('ready','partial','failed','cancelled') ORDER BY available_at,id LIMIT $2", [ownerId, bounded(limit, 100, 100)]);
    return result.rows.map(row => ({ scope: { ownerId, repository: row.repository }, job: row.payload }));
  }
  async claimJob(scope: StoreScope, workerId: string, leaseMs = 30_000, id?: string): Promise<StoredJob | undefined> {
    validateId(workerId); leaseMs = bounded(leaseMs, 30_000, 3_600_000); const p = this.params(scope);
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [p[0]]);
      const active = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM patchwork_jobs WHERE owner_id=$1 AND lease_expires_at>NOW() AND expires_at>NOW() AND status NOT IN ('ready','partial','failed','cancelled')", [p[0]]);
      if (Number(active.rows[0]?.count) >= 2) return undefined;
      await client.query("UPDATE patchwork_jobs SET status='failed',payload=payload||jsonb_build_object('status','failed','error','Maximum attempts reached','updatedAt',NOW()) WHERE owner_id=$1 AND repository=$2 AND expires_at>NOW() AND status NOT IN ('ready','partial','failed','cancelled') AND attempts>=max_attempts AND (lease_expires_at IS NULL OR lease_expires_at<=NOW())", p);
      const row = await client.query<{ id: string; payload: StoredJob }>("SELECT id,payload FROM patchwork_jobs WHERE owner_id=$1 AND repository=$2 AND expires_at>NOW() AND status NOT IN ('ready','partial','failed','cancelled') AND attempts<max_attempts AND available_at<=NOW() AND (lease_expires_at IS NULL OR lease_expires_at<=NOW()) AND ($3::text IS NULL OR id=$3) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1", [...p, id ?? null]);
      if (!row.rows[0]) return undefined;
      const result = await client.query<{ payload: StoredJob }>("UPDATE patchwork_jobs SET status='fetching',attempts=attempts+1,lease_owner=$4,lease_expires_at=NOW()+$5*INTERVAL '1 millisecond',payload=payload||jsonb_build_object('status','fetching','attempts',attempts+1,'leaseOwner',$4::text,'leaseExpiresAt',NOW()+$5*INTERVAL '1 millisecond','updatedAt',NOW()) WHERE owner_id=$1 AND repository=$2 AND id=$3 RETURNING payload", [...p, row.rows[0].id, workerId, leaseMs]); return result.rows[0]?.payload;
    });
  }
  async renewLease(scope: StoreScope, id: string, workerId: string, leaseMs = 30_000): Promise<boolean> {
    validateId(id); validateId(workerId); const r = await this.pool.query("UPDATE patchwork_jobs SET lease_expires_at=NOW()+$5*INTERVAL '1 millisecond',payload=payload||jsonb_build_object('leaseExpiresAt',NOW()+$5*INTERVAL '1 millisecond','updatedAt',NOW()) WHERE owner_id=$1 AND repository=$2 AND id=$3 AND lease_owner=$4 AND lease_expires_at>NOW() AND expires_at>NOW() AND status NOT IN ('ready','partial','failed','cancelled')", [...this.params(scope), id, workerId, bounded(leaseMs, 30_000, 3_600_000)]); return r.rowCount === 1;
  }
  async updateJobProgress(scope: StoreScope, id: string, workerId: string, update: { status: 'fetching' | 'indexing' | 'grouping'; progress: number; message: string }): Promise<boolean> {
    validateId(id); validateId(workerId);
    if (!['fetching', 'indexing', 'grouping'].includes(update.status) || !Number.isFinite(update.progress)) throw new Error('Invalid job progress');
    const r = await this.pool.query("UPDATE patchwork_jobs SET status=$5,payload=payload||jsonb_build_object('status',$5::text,'progress',GREATEST((payload->>'progress')::numeric,$6::numeric),'input',(payload->'input')||jsonb_build_object('progressMessage',$7::text),'updatedAt',NOW()) WHERE owner_id=$1 AND repository=$2 AND id=$3 AND lease_owner=$4 AND lease_expires_at>NOW() AND expires_at>NOW() AND status NOT IN ('ready','partial','failed','cancelled')", [...this.params(scope), id, workerId, update.status, Math.min(99, Math.max(0, update.progress)), update.message.slice(0, 500)]); return r.rowCount === 1;
  }
  async completeJob(scope: StoreScope, id: string, workerId: string, result: { snapshotId?: string; status: 'ready' | 'partial' | 'failed'; error?: string; errorCode?: string; retryable?: boolean }): Promise<boolean> {
    validateId(id); const patch = { status: result.status, ...(result.status !== 'failed' ? { progress: 100 } : {}), snapshotId: result.snapshotId, error: result.error?.slice(0, 2_000), errorCode: result.errorCode, retryable: result.retryable };
    const r = await this.pool.query("UPDATE patchwork_jobs SET status=$5,lease_owner=NULL,lease_expires_at=NULL,payload=(payload-'leaseOwner'-'leaseExpiresAt'-'error'-'errorCode'-'retryable'-'snapshotId')||$6::jsonb||jsonb_build_object('updatedAt',NOW()) WHERE owner_id=$1 AND repository=$2 AND id=$3 AND lease_owner=$4 AND lease_expires_at>NOW() AND expires_at>NOW() AND status NOT IN ('ready','partial','failed','cancelled')", [...this.params(scope), id, workerId, result.status, JSON.stringify(patch)]); return r.rowCount === 1;
  }
  async retryJob(scope: StoreScope, id: string, workerId: string, error: string, delayMs = 1_000): Promise<boolean> {
    validateId(id); const r = await this.pool.query("UPDATE patchwork_jobs SET status=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,available_at=NOW()+$5*INTERVAL '1 millisecond',lease_owner=NULL,lease_expires_at=NULL,payload=(payload-'leaseOwner'-'leaseExpiresAt')||jsonb_build_object('status',CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,'error',$6::text,'errorCode','RETRYABLE_ANALYSIS','retryable',true,'availableAt',NOW()+$5*INTERVAL '1 millisecond','updatedAt',NOW()) WHERE owner_id=$1 AND repository=$2 AND id=$3 AND lease_owner=$4 AND lease_expires_at>NOW() AND expires_at>NOW() AND status NOT IN ('ready','partial','failed','cancelled')", [...this.params(scope), id, workerId, Math.max(0, Math.min(delayMs, 3_600_000)), error.slice(0, 2_000)]); return r.rowCount === 1;
  }
  async cancelJob(scope: StoreScope, id: string): Promise<boolean> { validateId(id); const r = await this.pool.query("UPDATE patchwork_jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,payload=(payload-'leaseOwner'-'leaseExpiresAt')||jsonb_build_object('status','cancelled','updatedAt',NOW()) WHERE owner_id=$1 AND repository=$2 AND id=$3 AND expires_at>NOW() AND status NOT IN ('ready','partial','failed','cancelled')", [...this.params(scope), id]); return r.rowCount === 1; }
  async recordWebhookDelivery(scope: StoreScope, deliveryId: string): Promise<boolean> { validateId(deliveryId); const r = await this.pool.query('INSERT INTO patchwork_webhook_deliveries(owner_id,repository,delivery_id,expires_at) VALUES($1,$2,$3,NOW()+$4*INTERVAL \'1 millisecond\') ON CONFLICT(owner_id,repository,delivery_id) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE patchwork_webhook_deliveries.expires_at<=NOW() RETURNING delivery_id', [...this.params(scope), deliveryId, this.retention]); return r.rowCount === 1; }
  async deleteRepository(scope: StoreScope): Promise<void> { const p = this.params(scope); await this.transaction(async (client) => { for (const table of ['patchwork_snapshots', 'patchwork_jobs', 'patchwork_webhook_deliveries']) await client.query(`DELETE FROM ${table} WHERE owner_id=$1 AND repository=$2`, p); }); }
  async prune(): Promise<void> { for (const table of ['patchwork_snapshots', 'patchwork_jobs', 'patchwork_webhook_deliveries']) await this.pool.query(`DELETE FROM ${table} WHERE expires_at<=NOW()`); }
  async close(): Promise<void> { await this.pool.end(); }
}

/** DATABASE_URL is opt-in. Never silently fall back after a configured database fails. */
export async function createStore(config: StoreConfig = {}): Promise<SnapshotStore> {
  const databaseUrl = config.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) return new MemoryStore(config);
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, statement_timeout: 10_000 });
  try {
    if (config.autoMigrate !== false) {
      const sql = await readFile(new URL('../../../database/migrations/001_storage.sql', import.meta.url), 'utf8');
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(74219001)'); await client.query(sql); await client.query('COMMIT'); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } else await pool.query('SELECT 1');
    return new PostgresStore(pool, bounded(config.retentionMs, 86_400_000, 2_592_000_000), snapshotCeilings(config));
  } catch (error) { await pool.end(); throw error; }
}

export { verifyWebhook, acceptWebhookDelivery } from './webhooks.js';
export { createPostgresWebhookInbox, PostgresWebhookInbox, MemoryWebhookInbox } from './webhook-inbox.js';
export type { WebhookInbox, RefreshTask, RefreshState, WebhookEnvelope, LeasedWebhook } from './webhook-inbox.js';
