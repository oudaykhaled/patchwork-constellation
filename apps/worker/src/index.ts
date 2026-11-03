import { Worker } from 'node:worker_threads';
import { validateGraphSnapshot, type GraphSnapshot } from '@patchwork/contracts';
import type { AnalysisOptions, AnalysisProgress, AnalyzeInput } from '@patchwork/analysis';

type WorkerOptions = Omit<AnalysisOptions, 'fetch'>;
type Task = { kind: 'repository'; input: AnalyzeInput } | { kind: 'sources'; snapshot: GraphSnapshot; sourceKind: 'pr' | 'commit'; ids: string[] };
function runTask(task: Task, options: WorkerOptions = {}): Promise<GraphSnapshot> {
  options.signal?.throwIfAborted();
  const { signal, onProgress, ...serializable } = options;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./thread.ts', import.meta.url), { workerData: { task, options: serializable }, execArgv: ['--import', 'tsx'], resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } });
    let finished = false;
    const cleanup = async () => { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); await worker.terminate(); };
    // Completion releases an admission slot only after the worker has actually stopped.
    const fail = (error: Error) => { if (finished) return; finished = true; void cleanup().then(() => reject(error), () => reject(error)); };
    const cancel = () => fail(new DOMException('Analysis cancelled', 'AbortError'));
    const timeout = setTimeout(() => fail(Object.assign(new Error('Analysis exceeded its three-minute resource budget. Try a smaller repository.'), { code: 'ANALYSIS_TIMEOUT', status: 408 })), 180_000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.on('message', (message: { type: string; progress?: AnalysisProgress; snapshot?: GraphSnapshot; error?: { message: string; code?: string; status?: number; retryAfter?: number } }) => {
      if (finished) return;
      if (message.type === 'progress' && message.progress) onProgress?.(message.progress);
      else if (message.type === 'result' && message.snapshot) {
        try {
          const snapshot = validateGraphSnapshot(message.snapshot);
          finished = true; void cleanup().then(() => resolve(snapshot), reject);
        } catch { fail(new Error('Analysis worker returned an invalid graph snapshot.')); }
      }
      else if (message.type === 'error' && message.error) fail(Object.assign(new Error(message.error.message), { code: message.error.code, status: message.error.status, retryAfter: message.error.retryAfter }));
    });
    worker.once('error', fail);
    worker.once('exit', code => { if (!finished) fail(new Error(`Analysis worker stopped before completion (${code}).`)); });
  });
}
export function runAnalysisInWorker(input: AnalyzeInput, options: WorkerOptions = {}) { return runTask({ kind: 'repository', input }, options); }
export function runSourceAnalysisInWorker(snapshot: GraphSnapshot, sourceKind: 'pr' | 'commit', ids: string[], options: WorkerOptions = {}) { return runTask({ kind: 'sources', snapshot, sourceKind, ids }, options); }
