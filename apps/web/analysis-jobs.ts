import { createHash, randomUUID } from 'node:crypto';
import { GitHubClient, parseRepository, type GitHubOptions, type GitHubTelemetry } from '@patchwork/github';
import { newJob, type SnapshotStore, type StoreScope, type StoredJob } from '@patchwork/storage';
import { ANALYZER_VERSION, GROUPING_RULES_VERSION, createIncrementalAnalysisBaseline, type AnalyzeInput } from '@patchwork/analysis';
import { AnalysisJobSchema, type AnalysisJob, type GraphSnapshot, type ImportEdge } from '@patchwork/contracts';
import type { runAnalysisInWorker } from '../worker/src/index';
import { WorkerAdmission } from './worker-admission';
import { publicErrorCode, publicErrorMessage } from './public-errors';

export const ANALYSIS_VERSION = ANALYZER_VERSION;
export const GROUPING_VERSION = GROUPING_RULES_VERSION;
export interface PinnedAnalysisInput extends AnalyzeInput { displayContextRef?: string; /** Server-created refresh generation; never accepted from public analysis input. */ refreshVersion?: string }
export type AnalysisJobView = AnalysisJob & { stage: StoredJob['status']; version: string; graphUrl?: string; snapshot?: GraphSnapshot; code?: string; retryable?: boolean };
const terminal = (job: StoredJob) => ['ready', 'partial', 'failed', 'cancelled'].includes(job.status);
const errorMessage = publicErrorMessage;
function refreshIdentity(snapshot: GraphSnapshot, version?: string): GraphSnapshot {
  if (!version) return snapshot;
  const id = `${snapshot.id}:refresh:${createHash('sha256').update(version).digest('hex').slice(0, 16)}`;
  const edgeIdentity = (edge: ImportEdge) => edge.evidence && typeof edge.evidence === 'object' && edge.evidence.snapshotId === snapshot.id ? { ...edge, evidence: { ...edge.evidence, snapshotId: id } } : edge;
  return { ...snapshot, id, edges: snapshot.edges.map(edgeIdentity), sources: snapshot.sources.map(source => source.importEdges ? { ...source, importEdges: source.importEdges.map(edgeIdentity) } : source) };
}
const failureCode = (error: unknown, status: number) => { const code = publicErrorCode(error); return code !== 'REQUEST_FAILED' ? code : status >= 500 ? 'ANALYSIS_FAILED' : 'PERMANENT_ANALYSIS'; };

export function analysisJobId(scope: StoreScope, input: PinnedAnalysisInput) {
  if (input.refreshVersion !== undefined && (!/^[A-Za-z0-9-]{8,100}$/.test(input.refreshVersion))) throw Object.assign(new Error('Invalid refresh generation.'), { status: 400 });
  return createHash('sha256').update(JSON.stringify([scope.ownerId, scope.repository.toLowerCase(), input.contextRef, input.mode ?? 'pr', ANALYSIS_VERSION, GROUPING_VERSION, ...(input.refreshVersion ? [input.refreshVersion] : [])])).digest('hex');
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
  private failuresByOwner = new Map<string, number>();
  private repositoryEpochs = new Map<string, number>();
  private invalidatingRepositories = new Set<string>();
  private readonly workerId = `bff:${randomUUID()}`;
  private timer?: ReturnType<typeof setInterval>;
  private recoveryOwners = new Set<string>();
  constructor(private store: SnapshotStore, private admission: WorkerAdmission, private analyze: typeof runAnalysisInWorker,
    private save: (snapshot: GraphSnapshot, scope: StoreScope, isCurrent: () => boolean) => Promise<GraphSnapshot>,
    private credentials?: (scope: StoreScope) => Promise<Partial<NonNullable<Parameters<typeof runAnalysisInWorker>[1]>>>,
    private observations?: { onGitHub?: (scope: StoreScope, event: GitHubTelemetry) => void; onAnalysis?: (scope: StoreScope, event: { durationMs: number; failed: boolean }) => void }) {}

  startRecovery(ownerId = 'local-public') {
    this.recoveryOwners.add(ownerId);
    if (this.recoveryOwners.size > 100) this.recoveryOwners.delete(this.recoveryOwners.values().next().value!);
    if (this.timer || this.closing) return;
    const tick = () => { void (async () => { for (const owner of this.recoveryOwners) await this.recover(owner); })().catch(() => { /* Requests retain explicit storage errors; next tick retries discovery. */ }); };
    tick(); this.timer = setInterval(tick, 1_000); this.timer.unref();
  }
  private view(job: StoredJob): AnalysisJobView {
    const status = job.status === 'ready' || job.status === 'partial' ? 'ready' : job.status === 'failed' || job.status === 'cancelled' || job.status === 'queued' ? job.status : 'running';
    const inputRef = typeof job.input.contextRef === 'string' ? job.input.contextRef : undefined;
    return { ...AnalysisJobSchema.parse({ schemaVersion: '1', id: job.id, repository: String(job.input.repository), contextRef: job.input.displayContextRef ?? inputRef, contextSha: inputRef && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(inputRef) ? inputRef : undefined, status, progress: job.progress, message: job.error ?? String(job.input.progressMessage ?? (status === 'queued' ? 'Preparing analysis…' : 'Analyzing repository…')), createdAt: job.createdAt, updatedAt: job.updatedAt, snapshotId: job.snapshotId, error: job.error }), stage: job.status, version: `${ANALYSIS_VERSION}:${GROUPING_VERSION}`, graphUrl: job.snapshotId ? `/api/graphs/${encodeURIComponent(job.snapshotId)}?repository=${encodeURIComponent(String(job.input.repository))}` : undefined, code: job.errorCode, retryable: job.retryable };
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
      activeWorkersInProcess: [...this.controllers.keys()].filter(id => this.scopes.get(id)?.ownerId === ownerId).length, pendingEnqueueWrites: [...this.pending.keys()].filter(id => this.scopes.get(id)?.ownerId === ownerId).length, failuresSinceProcessStart: this.failuresByOwner.get(ownerId) ?? 0,
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
    const startedAt = Date.now(); let failed = false;
    this.cache(scope, job);
    const timeout = setTimeout(() => controller.abort(), 180_000);
    const heartbeat = setInterval(() => { void this.store.renewLease(scope, id, this.workerId, 30_000).then(ok => { if (!ok) controller.abort(); }, () => controller.abort()); }, 10_000); heartbeat.unref();
    let writes: Promise<unknown> = Promise.resolve();
    try {
      const input: PinnedAnalysisInput = { repository: String(job.input.repository), contextRef: String(job.input.contextRef), mode: job.input.mode === 'commit' ? 'commit' : 'pr' };
      const credentials = await this.credentials?.(scope);
      if (!isCurrent()) return;
      if (parseRepository(input.repository).fullName.toLowerCase() !== scope.repository.toLowerCase()) throw Object.assign(new Error('Analysis repository does not match its authorized scope.'), { status: 403, code: 'REPOSITORY_DENIED' });
      // Reuse is an optimization, not job identity or persisted input. Read only
      // after obtaining current authority, then convert the exact scoped result
      // to a bounded metadata-only baseline before crossing the worker boundary.
      const previous = await this.store.getLatestSnapshot(scope);
      if (!isCurrent()) return;
      let incrementalBaseline;
      if (previous?.repository.fullName.toLowerCase() === scope.repository.toLowerCase()) {
        try { incrementalBaseline = createIncrementalAnalysisBaseline(previous); } catch { /* Invalid old metadata safely falls back to full bounded analysis. */ }
      }
      const snapshot = await this.analyze(input, { ...credentials, incrementalBaseline, signal: controller.signal, onTelemetry: event => { try { this.observations?.onGitHub?.(scope, event); } catch { /* optional source-free sink */ } }, onProgress: progress => {
        const stage = progress.stage === 'indexing' ? 'indexing' : progress.stage === 'ready' ? 'grouping' : 'fetching';
        job.progress = Math.max(job.progress, Math.min(99, progress.progress)); job.status = stage; job.input.progressMessage = progress.message; job.updatedAt = new Date().toISOString(); this.cache(scope, job);
        // Serialize at most the producer's bounded phase events, never overwrite lease state.
        writes = writes.then(() => this.store.updateJobProgress(scope, id, this.workerId, { status: stage, progress: job.progress, message: progress.message })).then(ok => { if (!ok) controller.abort(); }).catch(() => controller.abort());
      } });
      controller.signal.throwIfAborted(); await writes;
      const current = await this.store.getJob(scope, id); if (!current || current.status === 'cancelled') return;
      if (!isCurrent()) return;
      const refreshed = refreshIdentity(snapshot, typeof job.input.refreshVersion === 'string' ? job.input.refreshVersion : undefined);
      const saved = await this.save({ ...refreshed, contextRef: String(job.input.displayContextRef ?? snapshot.contextRef) }, scope, isCurrent);
      if (!isCurrent()) return;
      const status = snapshot.coverage.status === 'complete' ? 'ready' : 'partial';
      if (await this.store.completeJob(scope, id, this.workerId, { snapshotId: saved.id, status })) {
        const view = this.cache(scope, { ...job, status, snapshotId: saved.id, progress: 100, updatedAt: new Date().toISOString() }); view.snapshot = saved; view.message = 'Graph ready';
      }
    } catch (error) {
      failed = true;
      await writes;
      const current = await this.store.getJob(scope, id); if (!current || current.status === 'cancelled') return;
      const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500;
      const hasExplicitStatus = typeof error === 'object' && error && 'status' in error;
      const retryable = this.closing || (!controller.signal.aborted && Boolean(hasExplicitStatus) && (status >= 500 || status === 429));
      if (retryable && job.attempts < job.maxAttempts) await this.store.retryJob(scope, id, this.workerId, this.closing ? 'Server restarted; analysis will resume from its pinned context.' : errorMessage(error), this.closing ? 0 : Math.min(30_000, 1_000 * 2 ** job.attempts));
      else if (await this.store.completeJob(scope, id, this.workerId, { status: 'failed', error: controller.signal.aborted ? 'Analysis exceeded its resource budget. Retry a smaller repository.' : errorMessage(error), errorCode: controller.signal.aborted ? 'ANALYSIS_TIMEOUT' : failureCode(error, status), retryable })) { this.failuresByOwner.set(scope.ownerId, (this.failuresByOwner.get(scope.ownerId) ?? 0) + 1); while (this.failuresByOwner.size > 128) this.failuresByOwner.delete(this.failuresByOwner.keys().next().value!); }
    } finally { clearTimeout(timeout); clearInterval(heartbeat); try { this.observations?.onAnalysis?.(scope, { durationMs: Math.max(0, Date.now() - startedAt), failed }); } catch { /* optional aggregate sink */ } }
  }
  async close() { this.closing = true; clearInterval(this.timer); for (const controller of this.controllers.values()) controller.abort(); await Promise.allSettled([...this.tasks]); }
}
