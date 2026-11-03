import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApplicationServer } from '../apps/web/server';
import type { GraphSnapshot } from '@patchwork/contracts';

let server: Server;
let base: string;
let snapshot: GraphSnapshot;

beforeAll(async () => {
  server = await createApplicationServer({ production: true });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  snapshot = await (await fetch(base + '/api/demo')).json() as GraphSnapshot;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

describe('local public API boundary', () => {
  it('reports the initialized store and explicitly excludes automatic restart resume', async () => {
    const config = await (await fetch(base + '/api/config')).json();
    expect(config.storage).toMatch(/^(memory|postgres)$/);
    expect(config.recovery.automaticJobResume).toBe(false);
  });
  it('returns validated demo data and bounded source discovery without external calls', async () => {
    const response = await fetch(base + `/api/sources?snapshotId=${encodeURIComponent(snapshot.id)}&kind=pr&page=1`);
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.sources.every((source: { kind: string }) => source.kind === 'pr')).toBe(true);
    expect(page.nextPage).toBeNull();
    expect(page.snapshot.id).toBe(snapshot.id);
    expect((await fetch(base + `/api/sources?snapshotId=${encodeURIComponent(snapshot.id)}&kind=pr&page=1000`)).status).toBe(400);
  });
  it('prevents a supplied repository from resolving another repository snapshot', async () => {
    const response = await fetch(base + `/api/snapshots/${encodeURIComponent(snapshot.id)}?repository=other/repository`);
    expect(response.status).toBe(404);
  });
});
