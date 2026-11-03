import { IncrementalAnalysisBaselineSchema } from '@patchwork/contracts';
import { parseRepository } from '@patchwork/github';
import type { AnalysisOptions } from '@patchwork/analysis';

export type WorkerOptions = Omit<AnalysisOptions, 'fetch' | 'gitFallback' | 'gitComparisonFallback'>;
const MAX_BASELINE_BYTES = 2 * 1024 * 1024;
const invalidBaseline = () => ({ schemaVersion: 'invalid' });
/** Never clone an arbitrary option bag (or an invalid baseline) into a worker. */
export function serializableWorkerOptions(options: WorkerOptions, repository?: string): Omit<WorkerOptions, 'signal' | 'onProgress' | 'onTelemetry'> {
  const result: Omit<WorkerOptions, 'signal' | 'onProgress' | 'onTelemetry'> = {};
  if (options.token !== undefined) {
    if (typeof options.token !== 'string' || options.token.length > 16_384) throw new Error('Invalid worker credential shape.');
    result.token = options.token;
  }
  if (options.allowPrivate !== undefined) {
    if (typeof options.allowPrivate !== 'boolean') throw new Error('Invalid worker authorization shape.');
    result.allowPrivate = options.allowPrivate;
  }
  const limits = { maxFiles: [1, 10_000], maxSourceFiles: [0, 500], sourcePages: [1, 100], maxRetries: [0, 3], maxRetryWaitMs: [0, 30_000], cacheTtlMs: [0, 60_000] } as const;
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = options[key], [min, max] = limits[key];
    if (value !== undefined) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Worker resource options exceed their bounds.'); result[key] = value; }
  }
  if (repository && options.incrementalBaseline !== undefined) {
    // Reject foreign or malformed metadata before cloning it; send only a
    // constant marker so analysis can report an explicit full-parse fallback.
    result.incrementalBaseline = invalidBaseline();
    try {
      if (Buffer.byteLength(JSON.stringify(options.incrementalBaseline)) <= MAX_BASELINE_BYTES) {
        const parsed = IncrementalAnalysisBaselineSchema.safeParse(options.incrementalBaseline);
        if (parsed.success && parsed.data.repository.toLowerCase() === parseRepository(repository).fullName.toLowerCase()) result.incrementalBaseline = parsed.data;
      }
    } catch { /* Cyclic/oversize/invalid option data never reaches the worker. */ }
  }
  return result;
}
