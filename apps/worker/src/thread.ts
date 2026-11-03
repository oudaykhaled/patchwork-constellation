import { parentPort, workerData } from 'node:worker_threads';
import { analyzeRepository, loadSourceChanges, type AnalysisOptions } from '@patchwork/analysis';
import type { GraphSnapshot } from '@patchwork/contracts';
if (!parentPort) throw new Error('Analysis thread requires a worker parent.');
const port = parentPort;
const data = workerData as { task: { kind: 'health' } | { kind: 'repository'; input: Parameters<typeof analyzeRepository>[0] } | { kind: 'sources'; snapshot: GraphSnapshot; sourceKind: 'pr' | 'commit'; ids: string[] }; options: AnalysisOptions };
const options: AnalysisOptions = { ...data.options, onProgress: progress => port.postMessage({ type: 'progress', progress }) };
try {
  if (data.task.kind === 'health') {
    port.postMessage({ type: 'health', schemaVersion: '1' });
  } else {
  const snapshot = data.task.kind === 'repository' ? await analyzeRepository(data.task.input, options) : await loadSourceChanges(data.task.snapshot, data.task.sourceKind, data.task.ids, options);
  port.postMessage({ type: 'result', snapshot });
  }
} catch (error) {
  const value = error as Error & { code?: string; status?: number; retryAfter?: number };
  port.postMessage({ type: 'error', error: { message: value.message || 'Analysis failed.', code: value.code, status: value.status, retryAfter: value.retryAfter } });
}
