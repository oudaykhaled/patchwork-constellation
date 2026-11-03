import { describe, expect, it } from 'vitest';
import { OperationalMetrics, readiness } from './operations';

describe('release operational observations', () => {
  it('retains safe numbers rather than arbitrary fields and marks unverified cost', () => {
    const metrics = new OperationalMetrics(); metrics.recordAnalysis(100, true);
    metrics.observeGitHub({ event: 'request', status: 429, remaining: 0, ...{ token: 'never-store', path: 'private/repo' } });
    metrics.observeGrouping({ outcome: 'timeout', durationMs: 55, requests: 1, inputTokens: null, outputTokens: null, ...{ prompt: 'private source' } });
    const value = metrics.snapshot(); expect(value.analysis.failures).toBe(1); expect(value.github.rateLimited).toBe(1); expect(value.provider.unknownUsage).toBe(1); expect(value.provider.costUsd).toBeNull();
    expect(JSON.stringify(value)).not.toMatch(/never-store|private|prompt|token/);
  });
  it('distinguishes unavailable dependencies and a stopping queue without leaking failures', async () => {
    const value = await readiness({ storage: async () => { throw new Error('postgres://private:secret'); }, productionAssets: async () => true, queue: async () => ({ queuedJobs: 0, leasedJobs: 0, oldestQueuedAgeMs: null, activeWorkersInProcess: 0, failuresSinceProcessStart: 0, stopping: true }) });
    expect(value.status).toBe('unavailable'); expect(value.checks).toEqual({ storage: 'unavailable', queue: 'unavailable', worker: 'not-configured', assets: 'ready' }); expect(JSON.stringify(value)).not.toContain('secret');
  });
  it('reports readiness for successful configured probes', async () => {
    expect((await readiness({ storage: async () => true, worker: async () => true, productionAssets: async () => true })).status).toBe('ready');
  });
  it('bounds a stalled dependency probe', async () => {
    const result = await readiness({ storage: () => new Promise(() => {}), productionAssets: async () => true }, 10); expect(result.status).toBe('unavailable'); expect(result.checks.storage).toBe('unavailable');
  });
});
