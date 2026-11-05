import { Worker } from 'node:worker_threads';
import { validateGraphSnapshot, type GraphSnapshot } from '@patchwork/contracts';
import { currentLocalGitRegistry, loadLocalGitRegistry, localGitConfigPath, type AnalysisProgress, type AnalyzeInput, type LocalGitRegistry, type LocalRepository } from '@patchwork/analysis';
import { receiveWorkerTelemetry } from './telemetry';
import { serializableWorkerOptions, type WorkerOptions } from './options';

type Task = { kind: 'repository'; input: AnalyzeInput } | { kind: 'sources'; snapshot: GraphSnapshot; sourceKind: 'pr' | 'commit'; ids: string[] };
export const DEFAULT_WORKER_HEAP_MB = 256;
/** What a worker thread needs from the server's local registry for one task. */
export interface LocalTaskContext { only: boolean; maxSnapshotBytes: number; repository?: LocalRepository; }
/**
 * Resolves the task's local repository in this (server) thread from the registry the
 * server loaded at startup, so a worker never re-reads the configuration, re-parses
 * footprint files or re-checks mirrors, and always agrees with the server. Only a
 * registered entry is handed over; task input never supplies a path.
 */
function localContextFor(task: Task, registry: LocalGitRegistry | undefined): LocalTaskContext | undefined {
  if (!registry) return undefined;
  const name = task.kind === 'repository' ? task.input.repository : task.snapshot.mode === 'local-git' ? task.snapshot.repository.fullName : undefined;
  const repository = name ? registry.get(name) : undefined;
  return { only: registry.only, maxSnapshotBytes: registry.limits.maxSnapshotBytes, ...(repository ? { repository } : {}) };
}
/** Local repositories may use the configured heap; every other task keeps the 256 MB default. */
const heapFor = (local: LocalTaskContext | undefined) => local?.repository ? local.repository.limits.workerHeapMb : DEFAULT_WORKER_HEAP_MB;
/** How long a stopping worker may take to kill and reap its own Git processes before it is terminated. */
export const WORKER_STOP_GRACE_MS = 2_000;
/** A process id the worker reported: never this process, never a process group (0, negative). */
const childPid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 1 && value !== process.pid;
function runTask(task: Task, options: WorkerOptions = {}): Promise<GraphSnapshot> {
  options.signal?.throwIfAborted();
  const serializable = serializableWorkerOptions(options, task.kind === 'repository' ? task.input.repository : undefined);
  // The server loads the registry at startup, so this is normally synchronous. A caller
  // that starts a task before any registry load waits for the one process-wide load.
  const registry = currentLocalGitRegistry();
  if (registry || !localGitConfigPath()) return startWorker(task, serializable, options, localContextFor(task, registry));
  return loadLocalGitRegistry().then(loaded => { options.signal?.throwIfAborted(); return startWorker(task, serializable, options, localContextFor(task, loaded)); });
}
function startWorker(task: Task, serializable: ReturnType<typeof serializableWorkerOptions>, options: WorkerOptions, local: LocalTaskContext | undefined): Promise<GraphSnapshot> {
  const { signal, onProgress, onTelemetry } = options;
  const heap = heapFor(local);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./thread.ts', import.meta.url), { workerData: { task, options: serializable, local }, execArgv: ['--import', 'tsx'], resourceLimits: { maxOldGenerationSizeMb: heap, stackSizeMb: 4 } });
    let finished = false;
    let telemetryCount = 0;
    // Git processes the thread started and has not yet seen exit.
    const running = new Set<number>();
    let markIdle!: () => void;
    const idle = new Promise<void>(resolve => { markIdle = resolve; });
    const cleanup = async () => {
      clearTimeout(timeout); signal?.removeEventListener('abort', cancel);
      // terminate() alone leaves the thread's Git processes running. Ask the thread to abort
      // first: it kills and reaps them, then answers 'idle' (or exits).
      try { worker.postMessage({ type: 'cancel' }); } catch { /* The thread has already stopped. */ }
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([idle, new Promise<void>(resolve => { grace = setTimeout(resolve, WORKER_STOP_GRACE_MS); })]);
      clearTimeout(grace);
      await worker.terminate();
      // Backstop for a thread that could not answer: stop what it reported and never saw exit.
      for (const pid of running) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
      running.clear();
    };
    // Completion releases an admission slot only after the worker has actually stopped.
    const fail = (error: Error) => { if (finished) return; finished = true; void cleanup().then(() => reject(error), () => reject(error)); };
    const cancel = () => fail(new DOMException('Analysis cancelled', 'AbortError'));
    const timeout = setTimeout(() => fail(Object.assign(new Error('Analysis exceeded its three-minute resource budget. Try a smaller repository.'), { code: 'ANALYSIS_TIMEOUT', status: 408 })), 180_000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.on('message', (message: { type: string; pid?: unknown; running?: unknown; progress?: AnalysisProgress; snapshot?: GraphSnapshot; error?: { message: string; code?: string; status?: number; retryAfter?: number } }) => {
      // Process bookkeeping continues after completion, while the thread is stopping.
      if (message.type === 'process') { if (childPid(message.pid)) { if (message.running === true) running.add(message.pid); else running.delete(message.pid); } return; }
      if (message.type === 'idle') { markIdle(); return; }
      if (finished) return;
      if (message.type === 'telemetry') { if (++telemetryCount <= 2_000) receiveWorkerTelemetry(message, onTelemetry); }
      else if (message.type === 'progress' && message.progress) onProgress?.(message.progress);
      else if (message.type === 'result' && message.snapshot) {
        try {
          const snapshot = validateGraphSnapshot(message.snapshot);
          finished = true; void cleanup().then(() => resolve(snapshot), reject);
        } catch { fail(new Error('Analysis worker returned an invalid graph snapshot.')); }
      }
      else if (message.type === 'error' && message.error) fail(Object.assign(new Error(message.error.message), { code: message.error.code, status: message.error.status, retryAfter: message.error.retryAfter }));
    });
    worker.once('error', fail);
    worker.once('exit', code => { markIdle(); if (!finished) fail(new Error(`Analysis worker stopped before completion (${code}).`)); });
  });
}
export function runAnalysisInWorker(input: AnalyzeInput, options: WorkerOptions = {}) { return runTask({ kind: 'repository', input }, options); }
export function runSourceAnalysisInWorker(snapshot: GraphSnapshot, sourceKind: 'pr' | 'commit', ids: string[], options: WorkerOptions = {}) { return runTask({ kind: 'sources', snapshot, sourceKind, ids }, options); }
