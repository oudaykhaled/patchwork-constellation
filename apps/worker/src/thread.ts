import { parentPort, workerData } from 'node:worker_threads';
import { analyzeLocalRepository, analyzeRepository, loadLocalSourceChanges, loadSourceChanges, type AnalysisOptions } from '@patchwork/analysis';
import type { GraphSnapshot } from '@patchwork/contracts';
import type { LocalTaskContext } from './index';
import { workerTelemetry } from './telemetry';
import { serializableWorkerOptions } from './options';
if (!parentPort) throw new Error('Analysis thread requires a worker parent.');
const port = parentPort;
const data = workerData as { task: { kind: 'health' } | { kind: 'repository'; input: Parameters<typeof analyzeRepository>[0] } | { kind: 'sources'; snapshot: GraphSnapshot; sourceKind: 'pr' | 'commit'; ids: string[] }; options: AnalysisOptions; local?: LocalTaskContext };
let telemetryCount = 0;
const localOnly = () => Object.assign(new Error('This server only analyzes its registered local repositories.'), { status: 400, code: 'LOCAL_ONLY' });
try {
  const serialized = serializableWorkerOptions(data.options, data.task.kind === 'repository' ? data.task.input.repository : undefined);
  const options: AnalysisOptions = { ...serialized, onProgress: progress => port.postMessage({ type: 'progress', progress }), onTelemetry: event => { const message = workerTelemetry(event); if (message && ++telemetryCount <= 2_000) port.postMessage(message); } };
  if (data.task.kind === 'health') {
    port.postMessage({ type: 'health', schemaVersion: '1' });
  } else {
  // The launcher hands over the registered entry the server already loaded (never a
  // path from task input); the worker does not re-read the configuration.
  const context = data.local;
  const registered = (fullName: string) => context?.repository && context.repository.fullName.toLowerCase() === fullName.toLowerCase() ? context.repository : undefined;
  let snapshot: GraphSnapshot;
  if (data.task.kind === 'repository') {
    const local = registered(data.task.input.repository);
    if (local) snapshot = await analyzeLocalRepository(data.task.input, local, { onProgress: options.onProgress, maxSnapshotBytes: context!.maxSnapshotBytes });
    else if (context?.only) throw localOnly();
    else snapshot = await analyzeRepository(data.task.input, options);
  } else if (data.task.snapshot.mode === 'local-git') {
    const local = registered(data.task.snapshot.repository.fullName);
    if (!local) throw Object.assign(new Error('This local repository is not registered on this server.'), { status: 404, code: 'LOCAL_UNAVAILABLE' });
    snapshot = await loadLocalSourceChanges(data.task.snapshot, data.task.sourceKind, data.task.ids, local, { onProgress: options.onProgress });
  } else if (context?.only) throw localOnly();
  else snapshot = await loadSourceChanges(data.task.snapshot, data.task.sourceKind, data.task.ids, options);
  port.postMessage({ type: 'result', snapshot });
  }
} catch (error) {
  const value = error as Error & { code?: string; status?: number; retryAfter?: number };
  port.postMessage({ type: 'error', error: { message: value.message || 'Analysis failed.', code: value.code, status: value.status, retryAfter: value.retryAfter } });
}
