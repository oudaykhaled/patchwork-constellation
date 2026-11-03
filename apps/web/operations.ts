/** Aggregate process-local observations only. Never retain names, IDs, paths, prompts or error text. */
export type QueueOperations = { queuedJobs: number; leasedJobs: number; oldestQueuedAgeMs: number | null; activeWorkersInProcess: number; failuresSinceProcessStart: number; stopping: boolean };
type NumericDistribution = { count: number; sum: number; max: number };
const distribution = (): NumericDistribution => ({ count: 0, sum: 0, max: 0 });
function observe(target: NumericDistribution, value: unknown) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return; target.count++; target.sum += value; target.max = Math.max(target.max, value); }
export class OperationalMetrics {
  private readonly started = Date.now();
  private analysis = distribution(); private analysisFailures = 0;
  private github = { requests: 0, rateLimited: 0, cacheHits: 0, retries: 0, minimumRemaining: null as number | null };
  private provider = { observations: 0, failures: 0, requests: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0, durationMs: distribution() };
  recordAnalysis(durationMs: number, failed: boolean) { observe(this.analysis, durationMs); if (failed) this.analysisFailures++; }
  observeGitHub(event: { event: string; status?: number; remaining?: number }) {
    if (event.event === 'request') { this.github.requests++; if (event.status === 429 || event.status === 403 && event.remaining === 0) this.github.rateLimited++; }
    if (event.event === 'cache-hit' || event.event === 'conditional-hit') this.github.cacheHits++;
    if (event.event === 'retry') this.github.retries++;
    if (typeof event.remaining === 'number' && Number.isFinite(event.remaining) && event.remaining >= 0) this.github.minimumRemaining = Math.min(this.github.minimumRemaining ?? event.remaining, event.remaining);
  }
  observeGrouping(event: { outcome: string; durationMs: number; requests: number; inputTokens: number | null; outputTokens: number | null }) {
    this.provider.observations++; if (!['success', 'baseline', 'cache-hit', 'disabled'].includes(event.outcome)) this.provider.failures++;
    observe(this.provider.durationMs, event.durationMs); if (Number.isInteger(event.requests) && event.requests >= 0) this.provider.requests += event.requests;
    if (event.inputTokens === null || event.outputTokens === null) this.provider.unknownUsage++;
    if (typeof event.inputTokens === 'number' && Number.isFinite(event.inputTokens) && event.inputTokens >= 0) this.provider.inputTokens += event.inputTokens;
    if (typeof event.outputTokens === 'number' && Number.isFinite(event.outputTokens) && event.outputTokens >= 0) this.provider.outputTokens += event.outputTokens;
  }
  snapshot(queue?: QueueOperations) {
    return { schemaVersion: '1', uptimeSeconds: Math.floor((Date.now() - this.started) / 1000), scope: 'process-local-aggregate', queue: queue ?? null, analysis: { durationMs: { ...this.analysis }, failures: this.analysisFailures }, github: { ...this.github, observationStatus: this.github.requests ? 'observed' : 'not-observed' }, provider: { ...this.provider, durationMs: { ...this.provider.durationMs }, observationStatus: this.provider.observations ? 'observed' : 'not-observed', costUsd: null, costStatus: 'unverified-provider-prices' } };
  }
}
export async function readiness(probes: { storage: () => Promise<unknown>; queue?: () => Promise<QueueOperations>; worker?: () => Promise<unknown>; productionAssets: () => Promise<unknown> }, timeoutMs = 2_000) {
  const checks: Record<string, 'ready' | 'unavailable' | 'not-configured'> = { storage: 'unavailable', queue: probes.queue ? 'unavailable' : 'not-configured', worker: probes.worker ? 'unavailable' : 'not-configured', assets: 'unavailable' };
  await Promise.all(Object.entries({ storage: probes.storage, queue: probes.queue, worker: probes.worker, assets: probes.productionAssets }).map(async ([key, probe]) => { if (!probe) return; let timer: ReturnType<typeof setTimeout> | undefined; try { const value = await Promise.race([probe(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Readiness probe deadline')), Math.max(1, Math.min(timeoutMs, 5_000))); })]); if (key === 'queue' && (value as QueueOperations).stopping) return; checks[key] = 'ready'; } catch { /* details deliberately omitted */ } finally { if (timer) clearTimeout(timer); } }));
  return { schemaVersion: '1', status: Object.values(checks).every(value => value === 'ready' || value === 'not-configured') ? 'ready' : 'unavailable', checks };
}
