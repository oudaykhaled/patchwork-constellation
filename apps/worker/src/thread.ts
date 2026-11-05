import { parentPort, workerData } from 'node:worker_threads';
import { analyzeLocalRepository, analyzeRepository, loadLocalSourceChanges, loadSourceChanges, observeGitProcesses, type AnalysisOptions } from '@patchwork/analysis';
import type { GraphSnapshot } from '@patchwork/contracts';
import type { LocalTaskContext } from './index';
import { workerTelemetry } from './telemetry';
import { serializableWorkerOptions } from './options';
if (!parentPort) throw new Error('Analysis thread requires a worker parent.');
const port = parentPort;
const data = workerData as { task: { kind: 'health' } | { kind: 'repository'; input: Parameters<typeof analyzeRepository>[0] } | { kind: 'sources'; snapshot: GraphSnapshot; sourceKind: 'pr' | 'commit'; ids: string[] }; options: AnalysisOptions; local?: LocalTaskContext };
let telemetryCount = 0;
const localOnly = () => Object.assign(new Error('This server only analyzes its registered local repositories.'), { status: 400, code: 'LOCAL_ONLY' });

// Terminating a worker does not stop the Git processes it started. The launcher therefore
// sends { type: 'cancel' } first: this thread aborts its work, which kills and reaps its own
// Git processes, and answers { type: 'idle' } once none is left. Every process is also
// reported, so the launcher can stop any that outlive a thread that could not answer.
const controller = new AbortController();
const running = new Set<number>();
let settling = false, idleSent = false;
const stopObserving = observeGitProcesses({
  spawned: pid => { running.add(pid); port.postMessage({ type: 'process', pid, running: true }); },
  exited: pid => { running.delete(pid); port.postMessage({ type: 'process', pid, running: false }); reportIdle(); },
});
const onMessage = (message: unknown) => { if ((message as { type?: unknown } | null)?.type === 'cancel') settle(); };
port.on('message', onMessage);
function reportIdle() {
  if (!settling || idleSent || running.size) return;
  idleSent = true; port.postMessage({ type: 'idle' });
  // Nothing else keeps this thread alive: it can now exit on its own.
  stopObserving(); port.off('message', onMessage);
}
function settle() { settling = true; controller.abort(); reportIdle(); }

try {
  const serialized = serializableWorkerOptions(data.options, data.task.kind === 'repository' ? data.task.input.repository : undefined);
  const options: AnalysisOptions = { ...serialized, signal: controller.signal, onProgress: progress => port.postMessage({ type: 'progress', progress }), onTelemetry: event => { const message = workerTelemetry(event); if (message && ++telemetryCount <= 2_000) port.postMessage(message); } };
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
    if (local) snapshot = await analyzeLocalRepository(data.task.input, local, { signal: controller.signal, onProgress: options.onProgress, maxSnapshotBytes: context!.maxSnapshotBytes });
    else if (context?.only) throw localOnly();
    else snapshot = await analyzeRepository(data.task.input, options);
  } else if (data.task.snapshot.mode === 'local-git') {
    const local = registered(data.task.snapshot.repository.fullName);
    if (!local) throw Object.assign(new Error('This local repository is not registered on this server.'), { status: 404, code: 'LOCAL_UNAVAILABLE' });
    snapshot = await loadLocalSourceChanges(data.task.snapshot, data.task.sourceKind, data.task.ids, local, { signal: controller.signal, onProgress: options.onProgress });
  } else if (context?.only) throw localOnly();
  else snapshot = await loadSourceChanges(data.task.snapshot, data.task.sourceKind, data.task.ids, options);
  port.postMessage({ type: 'result', snapshot });
  }
} catch (error) {
  const value = error as Error & { code?: string; status?: number; retryAfter?: number };
  port.postMessage({ type: 'error', error: { message: value.message || 'Analysis failed.', code: value.code, status: value.status, retryAfter: value.retryAfter } });
} finally {
  // Work that is still running (for example a sibling of a failed read) stops here as well.
  settle();
}
