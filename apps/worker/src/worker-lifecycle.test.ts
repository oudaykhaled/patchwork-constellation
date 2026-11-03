import { describe, expect, it, vi } from 'vitest';
import type { GraphSnapshot } from '@patchwork/contracts';
const control = vi.hoisted(() => ({ current: undefined as undefined | { emit: (event: string, value?: unknown) => void; finishTermination: () => void } }));
vi.mock('node:worker_threads', () => ({
  Worker: class {
    listeners = new Map<string, ((value: unknown) => void)[]>();
    stopped: Promise<number>;
    constructor() {
      let finish!: () => void;
      this.stopped = new Promise(resolve => { finish = () => resolve(0); });
      control.current = { emit: (event, value) => this.listeners.get(event)?.forEach(listener => listener(value)), finishTermination: finish };
    }
    on(event: string, listener: (value: unknown) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this; }
    once(event: string, listener: (value: unknown) => void) { return this.on(event, listener); }
    terminate() { return this.stopped; }
  },
}));
import { runAnalysisInWorker } from './index';
describe('worker admission lifecycle', () => {
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
    const snapshot = { id: 'result' } as GraphSnapshot;
    control.current!.emit('message', { type: 'result', snapshot });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    control.current!.finishTermination();
    await expect(work).resolves.toBe(snapshot);
  });
});
