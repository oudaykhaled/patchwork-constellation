import { describe, expect, it, vi } from 'vitest';
import { demoSnapshot } from '@patchwork/fixtures';
import { LOCAL_LIMIT_DEFAULTS, type LocalGitRegistry, type LocalRepository } from '@patchwork/analysis';
type Fake = { emit: (event: string, value?: unknown) => void; finishTermination: () => void; payload: unknown; resourceLimits: { maxOldGenerationSizeMb?: number }; events: string[] };
const control = vi.hoisted(() => ({ current: undefined as undefined | Fake, answerCancel: true, registry: undefined as unknown }));
vi.mock('node:worker_threads', () => ({
  Worker: class {
    listeners = new Map<string, ((value: unknown) => void)[]>();
    stopped: Promise<number>;
    events: string[] = [];
    constructor(_file: URL, options: { workerData: unknown; resourceLimits: { maxOldGenerationSizeMb?: number } }) {
      let finish!: () => void;
      this.stopped = new Promise(resolve => { finish = () => resolve(0); });
      control.current = { emit: (event, value) => this.listeners.get(event)?.forEach(listener => listener(value)), finishTermination: finish, payload: options.workerData, resourceLimits: options.resourceLimits, events: this.events };
    }
    on(event: string, listener: (value: unknown) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this; }
    once(event: string, listener: (value: unknown) => void) { return this.on(event, listener); }
    // Like the real thread: a cancel request is answered with 'idle' once its Git processes are gone.
    postMessage(message: { type: string }) { this.events.push(message.type); if (message.type === 'cancel' && control.answerCancel) queueMicrotask(() => this.listeners.get('message')?.forEach(listener => listener({ type: 'idle' }))); }
    terminate() { this.events.push('terminate'); return this.stopped; }
  },
}));
vi.mock('@patchwork/analysis', async importOriginal => ({ ...await importOriginal<typeof import('@patchwork/analysis')>(), currentLocalGitRegistry: () => control.registry }));
import { runAnalysisInWorker, WORKER_STOP_GRACE_MS } from './index';
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
describe('worker admission lifecycle', () => {
  it('forwards only validated typed telemetry and never clones callback functions', async () => {
    const observer = vi.fn(); const work = runAnalysisInWorker({ repository: 'acme/tool' }, { onTelemetry: observer });
    expect(() => structuredClone(control.current!.payload)).not.toThrow();
    const message = { type: 'telemetry', schemaVersion: '1', channel: 'github', event: { event: 'request', resource: 'tree', status: 200, remaining: 99 } };
    control.current!.emit('message', message); control.current!.emit('message', { ...message, event: { ...message.event, token: 'private' } });
    expect(observer).toHaveBeenCalledTimes(1); expect(observer).toHaveBeenCalledWith(message.event);
    control.current!.emit('message', { type: 'result', snapshot: structuredClone(demoSnapshot) }); control.current!.finishTermination(); await work;
  });
  it('does not release cancellation until termination completes', async () => {
    const controller = new AbortController();
    const work = runAnalysisInWorker({ repository: 'acme/tool' }, { signal: controller.signal });
    let settled = false; void work.then(() => { settled = true; }, () => { settled = true; });
    controller.abort();
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    control.current!.finishTermination();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(settled).toBe(true);
  });
  it('does not release successful completion until termination completes', async () => {
    const work = runAnalysisInWorker({ repository: 'acme/tool' });
    let settled = false; void work.then(() => { settled = true; });
    const snapshot = structuredClone(demoSnapshot);
    control.current!.emit('message', { type: 'result', snapshot });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    control.current!.finishTermination();
    await expect(work).resolves.toEqual(snapshot);
  });
  it('asks the thread to stop its Git processes before the worker is terminated', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const controller = new AbortController();
    const work = runAnalysisInWorker({ repository: 'acme/tool' }, { signal: controller.signal });
    const worker = control.current!;
    worker.emit('message', { type: 'process', pid: 4242, running: true });
    worker.emit('message', { type: 'process', pid: 4242, running: false });
    controller.abort();
    await settle();
    expect(worker.events).toEqual(['cancel', 'terminate']);
    worker.finishTermination();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    // The thread saw its process exit, so nothing is left to stop.
    expect(kill).not.toHaveBeenCalled();
  });
  it('stops the Git processes of a thread that does not answer, and nothing else', async () => {
    vi.useFakeTimers();
    control.answerCancel = false;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const work = runAnalysisInWorker({ repository: 'acme/tool' });
      const rejected = expect(work).rejects.toThrow('Analysis failed in thread');
      const worker = control.current!;
      for (const pid of [4242, 4343, 0, -1, 1, process.pid, 'x']) worker.emit('message', { type: 'process', pid, running: true });
      worker.emit('message', { type: 'process', pid: 4343, running: false });
      worker.emit('message', { type: 'error', error: { message: 'Analysis failed in thread' } });
      await settle();
      expect(worker.events).toEqual(['cancel']);
      await vi.advanceTimersByTimeAsync(WORKER_STOP_GRACE_MS);
      expect(worker.events).toEqual(['cancel', 'terminate']);
      worker.finishTermination();
      await rejected;
      expect(kill.mock.calls).toEqual([[4242, 'SIGKILL']]);
    } finally { control.answerCancel = true; vi.useRealTimers(); }
  });
  it('gives a registered local repository its configured heap and every other task the default', async () => {
    const limits = { ...LOCAL_LIMIT_DEFAULTS, workerHeapMb: 768 };
    const local = { fullName: 'local/app', owner: 'local', name: 'app', label: 'App', gitDir: '/unused', defaultRef: 'main', include: [], exclude: [], limits, fingerprint: 'f'.repeat(20) } satisfies LocalRepository;
    const registry = (only: boolean): LocalGitRegistry => ({ only, limits, repositories: [local], get: name => name.toLowerCase() === 'local/app' ? local : undefined });
    const launched = async (repository: string) => {
      const work = runAnalysisInWorker({ repository });
      const worker = control.current!;
      worker.emit('message', { type: 'error', error: { message: 'stop' } }); worker.finishTermination();
      await expect(work).rejects.toThrow('stop');
      return { heap: worker.resourceLimits.maxOldGenerationSizeMb, local: (worker.payload as { local?: { only: boolean; maxSnapshotBytes: number; repository?: { fullName: string } } }).local };
    };
    try {
      control.registry = registry(false);
      expect(await launched('local/app')).toMatchObject({ heap: 768, local: { only: false, repository: { fullName: 'local/app' } } });
      const github = await launched('acme/tool');
      expect(github.heap).toBe(256);
      expect(github.local).toEqual({ only: false, maxSnapshotBytes: limits.maxSnapshotBytes });
      control.registry = undefined;
      expect(await launched('acme/tool')).toEqual({ heap: 256, local: undefined });
    } finally { control.registry = undefined; }
  });
  it('rejects invalid worker payloads before crossing the service boundary', async () => {
    const work = runAnalysisInWorker({ repository: 'acme/tool' });
    const rejected = expect(work).rejects.toThrow('invalid graph snapshot');
    control.current!.emit('message', { type: 'result', snapshot: { id: 'unvalidated' } });
    control.current!.finishTermination();
    await rejected;
  });
});
