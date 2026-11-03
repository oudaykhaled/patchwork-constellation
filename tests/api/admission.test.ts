import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApplicationServer } from '../../apps/web/server';
import { createStore, type SnapshotStore } from '@patchwork/storage';
import { demoSnapshot } from '@patchwork/fixtures';
import type { GraphSnapshot } from '@patchwork/contracts';

type Options = NonNullable<Parameters<typeof createApplicationServer>[0]>;
type Pending = { signal?: AbortSignal; resolve: (value: GraphSnapshot) => void; reject: (error: Error) => void };
const openServers: Server[] = [];
const outstanding: Pending[] = [];
const post = (base: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function pending(signal?: AbortSignal): Promise<GraphSnapshot> { return new Promise((resolve, reject) => { const call = { signal, resolve, reject }; outstanding.push(call); }); }
function githubSnapshot(id: string): GraphSnapshot { return { ...structuredClone(demoSnapshot), id, mode: 'github' }; }
async function start(options: Options) {
  const server = await createApplicationServer({ production: true, ...options }); openServers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function seed(store: SnapshotStore, base: string, snapshot: GraphSnapshot) {
  await store.putSnapshot({ ownerId: 'local-public', repository: snapshot.repository.fullName }, snapshot);
  const response = await fetch(`${base}/api/snapshots/${encodeURIComponent(snapshot.id)}?repository=${snapshot.repository.fullName}`);
  expect(response.status).toBe(200);
}
afterEach(async () => {
  for (const call of outstanding.splice(0)) call.reject(new DOMException('Test complete', 'AbortError'));
  await Promise.all(openServers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});

describe('bounded shared worker admission', () => {
  it('reserves before delayed persistence and exposes a pollable deduplicated job', async () => {
    const store = await createStore({ databaseUrl: '' });
    let releaseWrites!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrites = resolve; });
    const write = store.putJob.bind(store);
    let jobWrites = 0;
    store.putJob = async (scope, job) => { jobWrites++; await writeGate; return write(scope, job); };
    const analyze: NonNullable<Options['runAnalysis']> = vi.fn((_input, options) => pending(options?.signal));
    const sources: NonNullable<Options['runSources']> = vi.fn((_snapshot, _kind, _ids, options) => pending(options?.signal));
    const base = await start({ store, runAnalysis: analyze, runSources: sources });
    const snapshot = githubSnapshot('admission-persistence'); await seed(store, base, snapshot);
    const first = post(base, '/api/analyze', { repository: 'owner/first' });
    await vi.waitFor(() => expect(jobWrites).toBe(1));
    const duplicate = await post(base, '/api/analyze', { repository: 'owner/first' });
    expect(duplicate.status).toBe(202);
    const reused = await duplicate.json(); expect(reused.reused).toBe(true);
    const queued = await fetch(base + '/api/jobs/' + reused.jobId);
    expect(queued.status).toBe(200); expect((await queued.json()).status).toBe('queued');
    const second = post(base, '/api/analyze', { repository: 'owner/second' });
    await vi.waitFor(() => expect(jobWrites).toBe(2));
    const blocked = await post(base, '/api/analyze', { repository: 'owner/third' });
    expect(blocked.status).toBe(429); expect((await blocked.json()).code).toBe('BUSY'); expect(blocked.headers.get('retry-after')).toBe('1');
    const mixed = await post(base, '/api/sources', { snapshotId: snapshot.id, kind: 'pr', ids: [snapshot.sources.find(source => source.kind === 'pr')!.id] });
    expect(mixed.status).toBe(429); expect(sources).not.toHaveBeenCalled(); expect(analyze).not.toHaveBeenCalled();
    releaseWrites(); expect((await first).status).toBe(202); expect((await second).status).toBe(202);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
  });

  it('applies the same cap to source workers in distinct snapshots and analysis jobs', async () => {
    const store = await createStore({ databaseUrl: '' });
    const analyze: NonNullable<Options['runAnalysis']> = vi.fn((_input, options) => pending(options?.signal));
    const sources: NonNullable<Options['runSources']> = vi.fn((_snapshot, _kind, _ids, options) => pending(options?.signal));
    const base = await start({ store, runAnalysis: analyze, runSources: sources });
    const snapshots = [githubSnapshot('admission-one'), githubSnapshot('admission-two'), githubSnapshot('admission-three')];
    for (const snapshot of snapshots) await seed(store, base, snapshot);
    const request = (snapshot: GraphSnapshot) => post(base, '/api/sources', { snapshotId: snapshot.id, kind: 'pr', ids: [snapshot.sources.find(source => source.kind === 'pr')!.id] });
    const first = request(snapshots[0]!); const second = request(snapshots[1]!);
    await vi.waitFor(() => expect(sources).toHaveBeenCalledTimes(2));
    expect((await request(snapshots[2]!)).status).toBe(429);
    expect((await post(base, '/api/analyze', { repository: 'owner/another' })).status).toBe(429);
    expect(analyze).not.toHaveBeenCalled(); expect(sources).toHaveBeenCalledTimes(2);
    outstanding[0]!.resolve(snapshots[0]!); outstanding[1]!.resolve(snapshots[1]!);
    expect((await first).status).toBe(200); expect((await second).status).toBe(200);
  });

  it('supersedes rapid selections without queueing and retains admission until cleanup settles', async () => {
    const store = await createStore({ databaseUrl: '' });
    const sources: NonNullable<Options['runSources']> = vi.fn((_snapshot, _kind, _ids, options) => pending(options?.signal));
    const base = await start({ store, runSources: sources });
    const snapshot = githubSnapshot('admission-supersede'); await seed(store, base, snapshot);
    const request = () => post(base, '/api/sources', { snapshotId: snapshot.id, kind: 'pr', ids: [snapshot.sources.find(source => source.kind === 'pr')!.id] });
    const first = request(); await vi.waitFor(() => expect(sources).toHaveBeenCalledTimes(1));
    const second = request(); await vi.waitFor(() => expect(sources).toHaveBeenCalledTimes(2));
    expect(outstanding[0]!.signal?.aborted).toBe(true);
    // Simulate worker termination still pending: the aborted call has not settled.
    const third = await request(); expect(third.status).toBe(429);
    expect(outstanding[1]!.signal?.aborted).toBe(true); expect(sources).toHaveBeenCalledTimes(2);
    outstanding[0]!.resolve(snapshot); outstanding[1]!.resolve(snapshot);
    expect((await first).status).toBe(409); expect((await second).status).toBe(409);
    const latest = request(); await vi.waitFor(() => expect(sources).toHaveBeenCalledTimes(3));
    outstanding[2]!.resolve(snapshot); expect((await latest).status).toBe(200);
    expect(sources).toHaveBeenCalledTimes(3);
  });
});
