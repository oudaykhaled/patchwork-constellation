import { describe, expect, it, vi } from 'vitest';
import { receiveWorkerTelemetry, workerTelemetry } from './telemetry';

describe('allowlisted worker observation boundary', () => {
  it('accepts typed quota and coverage facts without arbitrary output fields', () => {
    const observer = vi.fn(); const message = workerTelemetry({ event: 'request', resource: 'tree', status: 200, remaining: 99 });
    expect(receiveWorkerTelemetry(message, observer)).toBe(true); expect(observer).toHaveBeenCalledWith({ event: 'request', resource: 'tree', status: 200, remaining: 99 });
    for (const field of ['repository', 'path', 'token', 'prompt', 'ownerId', 'error']) expect(workerTelemetry({ event: 'request', resource: 'tree', [field]: 'private' })).toBeUndefined();
    expect(receiveWorkerTelemetry({ ...message, secret: 'private' }, observer)).toBe(false); expect(observer).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed telemetry, unknown categories and numeric poison', () => {
    for (const event of [{ event: 'request', resource: 'arbitrary' }, { event: 'error', resource: 'tree' }, { event: 'request', resource: 'tree', remaining: Number.NaN }, { event: 'request', resource: 'tree', status: 900 }, { event: 'retry', resource: 'tree', waitMs: -1 }]) expect(workerTelemetry(event)).toBeUndefined();
  });
  it('isolates a failing observer from successful worker observations', () => {
    expect(receiveWorkerTelemetry(workerTelemetry({ event: 'cache-hit', resource: 'source' }), () => { throw new Error('sink offline'); })).toBe(true);
  });
});
