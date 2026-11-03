import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphSnapshot } from '@patchwork/contracts';
import { GroupingService } from './index';

function snapshot(id = 'snapshot-1'): GraphSnapshot { return {
  schemaVersion: '1', id, repository: { owner: 'example', name: 'repo', fullName: 'example/repo', defaultBranch: 'main', htmlUrl: 'https://github.com/example/repo' },
  contextSha: id, contextRef: 'main', createdAt: '2026-11-03T00:00:00Z', mode: 'demo', sources: [], edges: [], coverage: { status: 'complete', reasons: [] },
  groups: [{ id: 'auth', label: 'Auth', origin: 'rules' }, { id: 'billing', label: 'Billing', origin: 'rules' }],
  nodes: [{ id: 'a', path: 'src/auth/session.ts', groupId: 'auth', sourceIds: [], presence: 'context' }, { id: 'b', path: 'src/auth/token.ts', groupId: 'auth', sourceIds: [], presence: 'context' }, { id: 'c', path: 'src/billing.ts', groupId: 'billing', sourceIds: [], presence: 'context' }],
}; }
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('revision recovery and lineage', () => {
  it('durably purges one owner repository and prevents stale revision resurrection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'constellation-revisions-')); directories.push(directory);
    const storagePath = join(directory, 'history.json'); const value = snapshot();
    const service = new GroupingService({ storagePath });
    const alice = service.mutate(value, { type: 'rename', groupId: 'auth', label: 'Alice identity' }, { tenantId: 'alice' });
    service.mutate(value, { type: 'rename', groupId: 'auth', label: 'Bob identity' }, { tenantId: 'bob' });
    const stale = new GroupingService({ storagePath }); expect(stale.current(value, { tenantId: 'alice' }).id).toBe(alice.revision.id);
    service.purgeRepository(value.repository.fullName, 'alice');
    expect(() => stale.mutate(value, { type: 'rename', groupId: 'auth', label: 'Resurrection' }, { tenantId: 'alice', expectedRevisionId: alice.revision.id })).toThrow('Grouping changed');
    const fresh = new GroupingService({ storagePath });
    expect(fresh.current(value, { tenantId: 'alice' }).groups[0]!.label).toBe('Auth');
    expect(fresh.current(value, { tenantId: 'bob' }).groups[0]!.label).toBe('Bob identity');
  });
  it('rejects a stale edit after a second process saves and exposes the winning current revision', () => {
    const directory = mkdtempSync(join(tmpdir(), 'constellation-revisions-')); directories.push(directory);
    const storagePath = join(directory, 'history.json');
    const first = new GroupingService({ storagePath }); const second = new GroupingService({ storagePath });
    const value = snapshot(); const baseline = first.current(value);
    const changed = second.mutate(value, { type: 'rename', groupId: 'auth', label: 'Identity' }, { expectedRevisionId: baseline.id });
    expect(() => first.mutate(value, { type: 'rename', groupId: 'billing', label: 'Money' }, { expectedRevisionId: baseline.id })).toThrow('Grouping changed');
    expect(first.current(value).id).toBe(changed.revision.id); expect(first.current(value).groups[0]!.label).toBe('Identity');
    const winner = new GroupingService({ storagePath }); expect(winner.current(value).groups[1]!.label).toBe('Billing');
  });
  it('migrates only manual overrides over confirmed renames and keeps tenant scopes independent', () => {
    const service = new GroupingService(); const initial = snapshot();
    service.mutate(initial, { type: 'move', fileIds: ['a'], groupId: 'billing' }, { tenantId: 'alice' });
    const fresh = snapshot('snapshot-2'); fresh.nodes[0] = { ...fresh.nodes[0]!, id: 'renamed', path: 'src/auth/login.ts', lineageAliases: ['src/auth/session.ts'] };
    const current = service.current(fresh, { tenantId: 'alice' });
    expect(current.membership.renamed).toBe('billing'); expect(current.lockedFileIds).toEqual(['renamed']); expect(current.reviewItems).toEqual([]);
    expect(current.canonicalHierarchy.membership.renamed).toBe('auth'); expect(current.snapshotId).toBe('snapshot-2');
    expect(service.current(fresh, { tenantId: 'bob' }).membership.renamed).toBe('auth');
  });
  it('queues ambiguous delete/recreate and removed overrides without fabricating continuity', () => {
    const service = new GroupingService(); const initial = snapshot();
    service.mutate(initial, { type: 'move', fileIds: ['a', 'b'], groupId: 'billing' });
    const fresh = snapshot('snapshot-2'); fresh.nodes = fresh.nodes.filter(node => node.id !== 'b'); fresh.nodes[0] = { ...fresh.nodes[0]!, presence: 'added', status: 'added', ambiguousLineage: true };
    const revision = service.current(fresh);
    expect(revision.membership.a).toBe('auth'); expect(revision.lockedFileIds).toEqual([]);
    expect(revision.reviewItems).toEqual(expect.arrayContaining([expect.objectContaining({ fileId: 'a', reason: 'ambiguous-lineage' }), expect.objectContaining({ fileId: 'b', reason: 'removed-file' })]));
  });
  it('reports stable file/group mappings and previous names for merge/undo transitions', () => {
    const service = new GroupingService(); const value = snapshot();
    const merged = service.mutate(value, { type: 'merge', groupIds: ['auth', 'billing'], label: 'Platform' });
    expect(merged.delta?.groupMappings).toEqual({ auth: 'auth', billing: 'auth' });
    expect(merged.delta?.membershipChanges).toEqual([{ fileId: 'c', fromGroupId: 'billing', toGroupId: 'auth' }]);
    expect(merged.delta?.renamedGroups).toEqual([{ groupId: 'auth', fromLabel: 'Auth', toLabel: 'Platform' }]);
    const undone = service.undo(value); expect(undone.snapshot.nodes).toEqual(value.nodes); expect(undone.snapshot.groups).toEqual(value.groups); expect(undone.canUndo).toBe(false);
  });
});
