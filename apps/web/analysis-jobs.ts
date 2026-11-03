import { createHash, randomUUID } from 'node:crypto';
import { GitHubClient, parseRepository, type GitHubOptions } from '@patchwork/github';
import { newJob, type SnapshotStore, type StoreScope, type StoredJob } from '@patchwork/storage';
import { ANALYZER_VERSION, type AnalyzeInput } from '@patchwork/analysis';
import type { GraphSnapshot } from '@patchwork/contracts';
import type { runAnalysisInWorker } from '../worker/src/index';
import { WorkerAdmission } from './worker-admission';
import { publicErrorCode, publicErrorMessage } from './public-errors';

export const ANALYSIS_VERSION = ANALYZER_VERSION;
export const GROUPING_VERSION = 'baseline-v1';
export interface PinnedAnalysisInput extends AnalyzeInput { displayContextRef?: string }
export type AnalysisJobView = { id: string; status: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'; stage: StoredJob['status']; progress: number; message: string; createdAt: string; updatedAt: string; version: string; snapshotId?: string; graphUrl?: string; snapshot?: GraphSnapshot; error?: string; code?: string; retryable?: boolean };
const terminal = (job: StoredJob) => ['ready', 'partial', 'failed', 'cancelled'].includes(job.status);
const errorMessage = publicErrorMessage;
const failureCode = (error: unknown, status: number) => { const code = publicErrorCode(error); return code !== 'REQUEST_FAILED' ? code : status >= 500 ? 'ANALYSIS_FAILED' : 'PERMANENT_ANALYSIS'; };

export function analysisJobId(scope: StoreScope, input: PinnedAnalysisInput) {
  return createHash('sha256').update(JSON.stringify([scope.ownerId, scope.repository.toLowerCase(), input.contextRef, input.mode ?? 'pr', ANALYSIS_VERSION, GROUPING_VERSION])).digest('hex');
}

/** Resolve mutable refs once; the durable input contains only the resulting immutable SHA. */
export async function pinAnalysisInput(input: AnalyzeInput, options: GitHubOptions & { allowPrivate?: boolean } = {}): Promise<PinnedAnalysisInput> {
  const address = parseRepository(input.repository), client = new GitHubClient({ ...options, signal: options.signal ?? AbortSignal.timeout(30_000) });
  const prefix = `/repos/${address.owner}/${address.name}`;
  const metadata = await client.get<{ default_branch: string; private: boolean }>(prefix);
  if (metadata.private && !options.allowPrivate) throw Object.assign(new Error('Private repository authorization is not configured.'), { status: 403, code: 'PRIVATE_UNSUPPORTED' });
  const displayContextRef = input.contextRef?.trim() || metadata.default_branch;
  const context = await client.get<{ sha: string }>(`${prefix}/commits/${encodeURIComponent(displayContextRef)}`);
  if (!/^[a-f0-9]{40,64}$/i.test(context.sha)) throw Object.assign(new Error('GitHub returned an invalid immutable ref.'), { status: 502, code: 'INVALID_RESPONSE' });
  return { repository: address.fullName, mode: input.mode, contextRef: context.sha.toLowerCase(), displayContextRef };
}

/** Durable leases are the source of truth. In-memory views are bounded reconnect accelerators. */
export class AnalysisJobs {
  private views = new Map<string, AnalysisJobView>();
  private scopes = new Map<string, StoreScope>();
  private pending = new Map<string, Promise<{ jobId: string; reused: boolean }>>();
  private controllers = new Map<string, AbortController>();
  private cancelled = new Set<string>();
  private tasks = new Set<Promise<void>>();
  private closing = false;
  private recovering = false;
  private failuresSinceStart = 0;
  private repositoryEpochs = new Map<string, number>();
  private invalidatingRepositories = new Set<string>();
  private readonly workerId = `bff:${randomUUID()}`;
  private timer?: ReturnType<typeof setInterval>;
  private recoveryOwners = new Set<string>();
  constructor(private store: SnapshotStore, private admission: WorkerAdmission, private analyze: typeof runAnalysisInWorker,
    private save: (snapshot: GraphSnapshot, scope: StoreScope, isCurrent: () => boolean) => Promise<GraphSnapshot>,
    private credentials?: (scope: StoreScope) => Promise<Partial<NonNullable<Parameters<typeof runAnalysisInWorker>[1]>>>) {}

  startRecovery(ownerId = 'local-public') {
    this.recoveryOwners.add(ownerId);
    if (this.recoveryOwners.size > 100) this.recoveryOwners.delete(this.recoveryOwners.values().next().value!);
    if (this.timer || this.closing) return;
    const tick = () => { void (async () => { for (const owner of this.recoveryOwners) await this.recover(owner); })().catch(() => { /* Requests retain explicit storage errors; next tick retries discovery. */ }); };
    tick(); this.timer = setInterval(tick, 1_000); this.timer.unref();
  }
  private view(job: StoredJob): AnalysisJobView {
    const status = job.status === 'ready' || job.status === 'partial' ? 'ready' : job.status === 'failed' || job.status === 'cancelled' || job.status === 'queued' ? job.status : 'running';
    return { id: job.id, status, stage: job.status, progress: job.progress, message: job.error ?? String(job.input.progressMessage ?? (status === 'queued' ? 'Preparing analysis…' : 'Analyzing repository…')), createdAt: job.createdAt, updatedAt: job.updatedAt, version: `${ANALYSIS_VERSION}:${GROUPING_VERSION}`, snapshotId: job.snapshotId, graphUrl: job.snapshotId ? `/api/graphs/${encodeURIComponent(job.snapshotId)}?repository=${encodeURIComponent(String(job.input.repository))}` : undefined, error: job.error, code: job.errorCode, retryable: job.retryable };
  }
  private cache(scope: StoreScope, job: StoredJob) {
    const prior = this.views.get(job.id), view = this.view(job); if (prior?.snapshot) view.snapshot = prior.snapshot;
    this.views.set(job.id, view); this.scopes.set(job.id, scope);
    while (this.views.size > 100) { const evict = [...this.views].find(([, value]) => ['ready', 'failed', 'cancelled'].includes(value.status)); if (!evict) break; this.views.delete(evict[0]); this.scopes.delete(evict[0]); }
    return view;
  }
  scopeForOwner(id: string, ownerId: string): StoreScope | undefined { const scope = this.scopes.get(id); return scope?.ownerId === ownerId ? { ...scope } : undefined; }
  private repositoryKey(scope: StoreScope) { return JSON.stringify([scope.ownerId, scope.repository.toLowerCase()]); }
  /** Fence before awaiting deletion; obsolete workers may terminate later but cannot publish. */
  async invalidateRepository(scope: StoreScope) {
    const key = this.repositoryKey(scope); this.repositoryEpochs.set(key, (this.repositoryEpochs.get(key) ?? 0) + 1); this.invalidatingRepositories.add(key);
    const ids = [...this.scopes].filter(([, value]) => this.repositoryKey(value) === key).map(([id]) => id);
    for (const id of ids) { this.controllers.get(id)?.abort(); this.cancelled.add(id); this.views.delete(id); }
    await Promise.allSettled(ids.map(id => this.pending.get(id)));
    await Promise.all(ids.map(id => this.store.cancelJob(scope, id)));
    for (const id of ids) { this.views.delete(id); this.scopes.delete(id); this.cancelled.delete(id); }
  }
  finishInvalidation(scope: StoreScope) { this.invalidatingRepositories.delete(this.repositoryKey(scope)); }
  async submit(scope: StoreScope, input: PinnedAnalysisInput): Promise<{ jobId: string; reused: boolean }> {
    if (this.closing) throw Object.assign(new Error('Server is stopping. Reconnect and retry.'), { status: 503 });
    if (this.invalidatingRepositories.has(this.repositoryKey(scope))) throw Object.assign(new Error('Repository access changed. Reconnect and analyze again.'), { status: 409, code: 'REPOSITORY_INVALIDATED' });
    const id = analysisJobId(scope, input), pending = this.pending.get(id);
    this.startRecovery(scope.ownerId);
    if (pending) return { jobId: id, reused: true };
    if (this.controllers.has(id) && !this.views.has(id)) throw Object.assign(new Error('An obsolete worker is still stopping. Retry shortly.'), { status: 429, code: 'BUSY', retryAfter: 1 });
    const cached = this.views.get(id);
    if (cached && !['failed', 'cancelled'].includes(cached.status)) return { jobId: id, reused: true };
    // Reserve before the first storage await, including delayed enqueue writes.
    const release = this.admission.reserve();
    const job = newJob({ ...input, analysisVersion: ANALYSIS_VERSION, groupingVersion: GROUPING_VERSION }, { id, maxAttempts: 3 });
    this.cache(scope, job);
    const promise = (async () => {
      let handedOff = false;
      try {
        const result = await this.store.enqueueJob(scope, job); this.cache(scope, result.job);
        if (this.cancelled.delete(id)) { await this.store.cancelJob(scope, id); release(); return { jobId: id, reused: !result.created }; }
        if (!terminal(result.job)) { handedOff = true; this.launch(scope, id, release); }
        else release();
        return { jobId: id, reused: !result.created };
      } catch (error) { if (!handedOff) release(); this.views.delete(id); this.scopes.delete(id); throw error; }
      finally { this.pending.delete(id); }
    })();
    this.pending.set(id, promise); return promise;
  }
  async get(id: string, scope?: StoreScope, includeSnapshot = true): Promise<AnalysisJobView | undefined> {
    const known = this.scopes.get(id);
    if (scope && known && (scope.ownerId !== known.ownerId || scope.repository.toLowerCase() !== known.repository.toLowerCase())) return undefined;
    const selected = scope ?? known;
    if (!selected) return undefined;
    if (this.invalidatingRepositories.has(this.repositoryKey(selected))) return undefined;
    const epoch = this.repositoryEpochs.get(this.repositoryKey(selected)) ?? 0;
    this.startRecovery(selected.ownerId);
    if (this.pending.has(id)) return this.views.get(id);
    const saved = await this.store.getJob(selected, id); if (!saved) return undefined;
    if ((this.repositoryEpochs.get(this.repositoryKey(selected)) ?? 0) !== epoch) return undefined;
    const view = this.cache(selected, saved);
    if (saved.snapshotId && includeSnapshot) view.snapshot = await this.store.getSnapshot(selected, saved.snapshotId);
    if ((this.repositoryEpochs.get(this.repositoryKey(selected)) ?? 0) !== epoch) return undefined;
    if (!includeSnapshot) { const { snapshot: _snapshot, ...metadata } = view; return metadata; }
    return view;
  }
  async cancel(id: string, scope?: StoreScope) {
    const view = await this.get(id, scope); if (!view) return undefined;
    const selected = scope ?? this.scopes.get(id)!;
    if (this.pending.has(id)) this.cancelled.add(id);
    this.controllers.get(id)?.abort(); await this.store.cancelJob(selected, id);
    return this.get(id, selected);
  }
  /** Aggregate operational counters, without repository IDs, source paths or credentials. */
  async operationalStatus(ownerId = 'local-public') {
    const pending = await this.store.listJobs(ownerId, 100), now = Date.now();
    const queued = pending.filter(entry => entry.job.status === 'queued');
    return { storage: this.store.kind, pendingJobs: pending.length, queuedJobs: queued.length,
      leasedJobs: pending.filter(entry => entry.job.leaseExpiresAt && Date.parse(entry.job.leaseExpiresAt) > now).length,
      oldestQueuedAgeMs: queued.length ? Math.max(...queued.map(entry => Math.max(0, now - Date.parse(entry.job.createdAt)))) : 0,
      activeWorkersInProcess: this.controllers.size, pendingEnqueueWrites: this.pending.size, failuresSinceProcessStart: this.failuresSinceStart,
      discoveryLimit: 100, stopping: this.closing };
  }
  private async recover(ownerId: string) {
    if (this.closing || this.recovering) return; this.recovering = true;
    try {
      for (const { scope, job } of await this.store.listJobs(ownerId, 100)) {
        if (this.closing) break;
        if (this.invalidatingRepositories.has(this.repositoryKey(scope))) continue;
        this.cache(scope, job);
        if (this.controllers.has(job.id) || this.pending.has(job.id) || Date.parse(job.availableAt) > Date.now() || (job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > Date.now())) continue;
        let release: () => void; try { release = this.admission.reserve(); } catch { break; }
        this.launch(scope, job.id, release);
      }
    } finally { this.recovering = false; }
  }
  private launch(scope: StoreScope, id: string, release: () => void) {
    const controller = new AbortController(); this.controllers.set(id, controller);
    const task = this.run(scope, id, controller).finally(() => { if (this.controllers.get(id) === controller) this.controllers.delete(id); this.tasks.delete(task); release(); });
    this.tasks.add(task); void task.catch(() => {});
  }
  private async run(scope: StoreScope, id: string, controller: AbortController) {
    const epoch = this.repositoryEpochs.get(this.repositoryKey(scope)) ?? 0;
    const isCurrent = () => !controller.signal.aborted && (this.repositoryEpochs.get(this.repositoryKey(scope)) ?? 0) === epoch;
    const job = await this.store.claimJob(scope, this.workerId, 30_000, id); if (!job) return;
    this.cache(scope, job);
    const timeout = setTimeout(() => controller.abort(), 180_000);
    const heartbeat = setInterval(() => { void this.store.renewLease(scope, id, this.workerId, 30_000).then(ok => { if (!ok) controller.abort(); }, () => controller.abort()); }, 10_000); heartbeat.unref();
    let writes: Promise<unknown> = Promise.resolve();
    try {
      const input: PinnedAnalysisInput = { repository: String(job.input.repository), contextRef: String(job.input.contextRef), mode: job.input.mode === 'commit' ? 'commit' : 'pr' };
      const credentials = await this.credentials?.(scope);
      const snapshot = await this.analyze(input, { ...credentials, signal: controller.signal, onProgress: progress => {
        const stage = progress.stage === 'indexing' ? 'indexing' : progress.stage === 'ready' ? 'grouping' : 'fetching';
        job.progress = Math.max(job.progress, Math.min(99, progress.progress)); job.status = stage; job.input.progressMessage = progress.message; job.updatedAt = new Date().toISOString(); this.cache(scope, job);
        // Serialize at most the producer's bounded phase events, never overwrite lease state.
        writes = writes.then(() => this.store.updateJobProgress(scope, id, this.workerId, { status: stage, progress: job.progress, message: progress.message })).then(ok => { if (!ok) controller.abort(); }).catch(() => controller.abort());
      } });
      controller.signal.throwIfAborted(); await writes;
      const current = await this.store.getJob(scope, id); if (!current || current.status === 'cancelled') return;
      if (!isCurrent()) return;
      const saved = await this.save({ ...snapshot, contextRef: String(job.input.displayContextRef ?? snapshot.contextRef) }, scope, isCurrent);
      if (!isCurrent()) return;
      const status = snapshot.coverage.status === 'complete' ? 'ready' : 'partial';
      if (await this.store.completeJob(scope, id, this.workerId, { snapshotId: saved.id, status })) {
        const view = this.cache(scope, { ...job, status, snapshotId: saved.id, progress: 100, updatedAt: new Date().toISOString() }); view.snapshot = saved; view.message = 'Graph ready';
      }
    } catch (error) {
      await writes;
      const current = await this.store.getJob(scope, id); if (!current || current.status === 'cancelled') return;
      const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500;
      const hasExplicitStatus = typeof error === 'object' && error && 'status' in error;
      const retryable = this.closing || (!controller.signal.aborted && Boolean(hasExplicitStatus) && (status >= 500 || status === 429));
      if (retryable && job.attempts < job.maxAttempts) await this.store.retryJob(scope, id, this.workerId, this.closing ? 'Server restarted; analysis will resume from its pinned context.' : errorMessage(error), this.closing ? 0 : Math.min(30_000, 1_000 * 2 ** job.attempts));
      else if (await this.store.completeJob(scope, id, this.workerId, { status: 'failed', error: controller.signal.aborted ? 'Analysis exceeded its resource budget. Retry a smaller repository.' : errorMessage(error), errorCode: controller.signal.aborted ? 'ANALYSIS_TIMEOUT' : failureCode(error, status), retryable })) this.failuresSinceStart++;
    } finally { clearTimeout(timeout); clearInterval(heartbeat); }
  }
  async close() { this.closing = true; clearInterval(this.timer); for (const controller of this.controllers.values()) controller.abort(); await Promise.allSettled([...this.tasks]); }
}
