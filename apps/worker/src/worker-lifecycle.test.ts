import { describe, expect, it, vi } from 'vitest';
import { demoSnapshot } from '@patchwork/fixtures';
const control = vi.hoisted(() => ({ current: undefined as undefined | { emit: (event: string, value?: unknown) => void; finishTermination: () => void; payload: unknown } }));
vi.mock('node:worker_threads', () => ({
  Worker: class {
    listeners = new Map<string, ((value: unknown) => void)[]>();
    stopped: Promise<number>;
    constructor(_file: URL, options: { workerData: unknown }) {
      let finish!: () => void;
      this.stopped = new Promise(resolve => { finish = () => resolve(0); });
      control.current = { emit: (event, value) => this.listeners.get(event)?.forEach(listener => listener(value)), finishTermination: finish, payload: options.workerData };
    }
    on(event: string, listener: (value: unknown) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this; }
    once(event: string, listener: (value: unknown) => void) { return this.on(event, listener); }
    terminate() { return this.stopped; }
  },
}));
import { runAnalysisInWorker } from './index';
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
  it('rejects invalid worker payloads before crossing the service boundary', async () => {
    const work = runAnalysisInWorker({ repository: 'acme/tool' });
    const rejected = expect(work).rejects.toThrow('invalid graph snapshot');
    control.current!.emit('message', { type: 'result', snapshot: { id: 'unvalidated' } });
    control.current!.finishTermination();
    await rejected;
  });
});
