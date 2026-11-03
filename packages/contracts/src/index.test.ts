import { describe, expect, it } from 'vitest';
import { GraphSnapshotSchema, type GraphSnapshot } from './index';

const valid: GraphSnapshot = {
  id: 'snapshot-1', contextSha: '123', contextRef: 'main', createdAt: '2026-11-03T00:00:00Z', mode: 'demo',
  repository: { owner: 'demo', name: 'repo', fullName: 'demo/repo', defaultBranch: 'main', htmlUrl: 'https://github.com/demo/repo' },
  nodes: [
    { id: 'a', path: 'src/a.ts', groupId: 'module', sourceIds: ['pr-1'] },
    { id: 'b', path: 'src/b.ts', groupId: 'module', sourceIds: [] },
  ],
  groups: [{ id: 'module', label: 'Module' }],
  edges: [{ id: 'import-a-b', source: 'a', target: 'b', kind: 'import', evidence: { path: 'src/a.ts', line: 1, specifier: './b' } }],
  sources: [{ id: 'pr-1', kind: 'pr', title: 'Change A', label: '#1', number: 1, url: 'https://github.com/demo/repo/pull/1', files: [{ fileId: 'a', path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }] }],
  coverage: { status: 'complete', reasons: [] },
};

describe('graph boundary validation', () => {
  it('accepts a consistent typed snapshot', () => expect(GraphSnapshotSchema.safeParse(valid).success).toBe(true));
  it('rejects dangling edges and unknown groups', () => {
    expect(GraphSnapshotSchema.safeParse({ ...valid, edges: [{ ...valid.edges[0], target: 'missing' }] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, nodes: [{ ...valid.nodes[0], groupId: 'missing' }] }).success).toBe(false);
  });
  it('rejects duplicate identities, memberships and invalid counters', () => {
    expect(GraphSnapshotSchema.safeParse({ ...valid, nodes: [...valid.nodes, valid.nodes[0]] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, nodes: [{ ...valid.nodes[0], sourceIds: ['pr-1', 'pr-1'] }, valid.nodes[1]] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, sources: [{ ...valid.sources[0], files: [{ ...valid.sources[0].files[0], additions: -1 }] }] }).success).toBe(false);
  });
  it('rejects unknown versions and references before the graph reaches the UI', () => {
    expect(GraphSnapshotSchema.safeParse({ ...valid, schemaVersion: '999' }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, sources: [{ ...valid.sources[0], files: [{ ...valid.sources[0].files[0], fileId: 'missing' }] }] }).success).toBe(false);
  });
});
