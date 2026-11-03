import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createStore } from '@patchwork/storage';
import { createApplicationServer } from '../../apps/web/server';

let server: Server; let base: string; let storageUnavailable = false;
beforeAll(async () => {
  vi.stubEnv('OPS_METRICS_ENABLED', 'true');
  const store = await createStore({ databaseUrl: '' }); const read = store.getSnapshot.bind(store);
  store.getSnapshot = async (...args) => { if (storageUnavailable) throw new Error('postgres://operator:private'); return read(...args); };
  server = await createApplicationServer({ production: true, store }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); });
test('operational routes report successful probes and redact dependency failures', async () => {
  const ready = await fetch(base + '/api/readiness'); expect(ready.status).toBe(200); expect((await ready.json()).checks).toMatchObject({ storage: 'ready', queue: 'ready', assets: 'ready' });
  const metrics = await (await fetch(base + '/api/metrics')).json(); expect(metrics.scope).toBe('process-local-aggregate'); expect(metrics.provider.costUsd).toBeNull(); expect(metrics.github.observationStatus).toBe('not-observed');
  storageUnavailable = true; const failed = await fetch(base + '/api/readiness'); expect(failed.status).toBe(503); const body = await failed.text(); expect(body).toContain('unavailable'); expect(body).not.toMatch(/operator|private|postgres/); expect(failed.headers.get('cache-control')).toBe('no-store');
});
