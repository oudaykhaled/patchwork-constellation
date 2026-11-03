import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupingService } from '@patchwork/ai';
import { createApplicationServer } from '../../apps/web/server';

const servers: Server[] = []; const directories: string[] = [];
const post = (base: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function start(storagePath: string) {
  const server = await createApplicationServer({ production: true, grouping: new GroupingService({ storagePath }) }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('versioned durable grouping HTTP contract', () => {
  it('persists edits and undo across server reload and rejects concurrent/stale writes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'constellation-grouping-api-')); directories.push(directory); const storagePath = join(directory, 'history.json');
    const base = await start(storagePath);
    const snapshot = await (await fetch(base + '/api/demo')).json();
    const current = await (await fetch(base + '/api/grouping/current?snapshotId=' + encodeURIComponent(snapshot.id))).json();
    expect(current.canUndo).toBe(false);
    const edit = { snapshotId: snapshot.id, expectedRevisionId: current.revision.id, operation: { type: 'rename', groupId: snapshot.groups[0].id, label: 'Durable identity' } };
    const [first, second] = await Promise.all([post(base, '/api/grouping/mutate', edit), post(base, '/api/grouping/mutate', edit)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const accepted = await (first.status === 200 ? first : second).json();
    expect(accepted.delta.renamedGroups[0].toLabel).toBe('Durable identity'); expect(accepted.canUndo).toBe(true);
    const stale = await post(base, '/api/grouping/undo', { snapshotId: snapshot.id, expectedRevisionId: current.revision.id }); expect(stale.status).toBe(409); expect((await stale.json()).code).toBe('REVISION_CONFLICT');
    const reloadedBase = await start(storagePath);
    await fetch(reloadedBase + '/api/demo');
    const reloaded = await (await fetch(reloadedBase + '/api/grouping/current?snapshotId=' + encodeURIComponent(snapshot.id))).json();
    expect(reloaded.revision.id).toBe(accepted.revision.id); expect(reloaded.snapshot.groups[0].label).toBe('Durable identity');
    const undo = await post(reloadedBase, '/api/grouping/undo', { snapshotId: snapshot.id, expectedRevisionId: reloaded.revision.id });
    expect(undo.status).toBe(200); const restored = await undo.json(); expect(restored.canUndo).toBe(false); expect(restored.revision.restoresRevisionId).toBe(current.revision.id); expect(restored.snapshot.groups[0].label).toBe(snapshot.groups[0].label);
    expect(restored.snapshot.edges).toEqual(snapshot.edges); expect(restored.snapshot.sources).toEqual(snapshot.sources); expect(restored.snapshot.contextSha).toBe(snapshot.contextSha);
  });
  it('requires mutation preconditions and keeps unavailable proposals recoverable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'constellation-grouping-api-')); directories.push(directory);
    const base = await start(join(directory, 'history.json')); const snapshot = await (await fetch(base + '/api/demo')).json();
    const missing = await post(base, '/api/grouping/mutate', { snapshotId: snapshot.id, operation: { type: 'rename', groupId: snapshot.groups[0].id, label: 'No precondition' } }); expect(missing.status).toBe(400);
    const current = await (await fetch(base + '/api/grouping/current?snapshotId=' + encodeURIComponent(snapshot.id))).json();
    const diff = await post(base, '/api/grouping/diff', { snapshotId: snapshot.id }); expect(diff.status).toBe(200); expect((await diff.json()).membershipChanges).toEqual([]);
    const rejected = await post(base, '/api/grouping/reject', { snapshotId: snapshot.id, expectedRevisionId: current.revision.id, proposalId: 'unavailable' }); expect(rejected.status).toBe(404);
    const foreign = await fetch(base + '/api/grouping/current?snapshotId=foreign'); expect(foreign.status).toBe(404);
  });
});
