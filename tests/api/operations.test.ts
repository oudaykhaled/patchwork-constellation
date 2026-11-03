import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createStore } from '@patchwork/storage';
import { demoSnapshot } from '@patchwork/fixtures';
import { createApplicationServer } from '../../apps/web/server';

let server: Server; let base: string; let storageUnavailable = false;
beforeAll(async () => {
  vi.stubEnv('OPS_METRICS_ENABLED', 'true');
  const store = await createStore({ databaseUrl: '' }); const read = store.getSnapshot.bind(store);
  store.getSnapshot = async (...args) => { if (storageUnavailable) throw new Error('postgres://operator:private'); return read(...args); };
  vi.stubEnv('AI_ENABLED', 'false');
  server = await createApplicationServer({ production: true, store, runAnalysis: async (_input, options) => { options?.onTelemetry?.({ event: 'request', resource: 'tree', status: 200, remaining: 42 }); return structuredClone(demoSnapshot); } }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); });
test('operational routes report successful probes and redact dependency failures', async () => {
  const ready = await fetch(base + '/api/readiness'); const readiness = await ready.json(); expect(readiness.checks).toMatchObject({ storage: 'ready', queue: 'ready', worker: 'ready' }); expect(ready.status).toBe(readiness.checks.assets === 'ready' ? 200 : 503);
  const proposal = await fetch(base + '/api/grouping', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ snapshotId: demoSnapshot.id, enabled: true }) }); expect(proposal.status).toBe(200);
  const submitted = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ repository: demoSnapshot.repository.fullName, contextRef: 'a'.repeat(40) }) }); const { jobId } = await submitted.json();
  await vi.waitFor(async () => expect((await fetch(`${base}/api/jobs/${jobId}`).then(value => value.json())).status).toBe('ready'));
  const metrics = await (await fetch(base + '/api/metrics')).json(); expect(metrics.scope).toBe('owner-process-aggregate'); expect(metrics.provider.costUsd).toBeNull(); expect(metrics.provider.outcomes.disabled).toBe(1); expect(metrics.provider.requests).toBe(0); expect(metrics.github.observationStatus).toBe('observed'); expect(metrics.github.requests).toBe(1); expect(metrics.analysis.durationMs.count).toBe(1); expect(metrics.github.minimumRemaining).toBe(42);
  storageUnavailable = true; const failed = await fetch(base + '/api/readiness'); expect(failed.status).toBe(503); const body = await failed.text(); expect(body).toContain('unavailable'); expect(body).not.toMatch(/operator|private|postgres/); expect(failed.headers.get('cache-control')).toBe('no-store');
});
