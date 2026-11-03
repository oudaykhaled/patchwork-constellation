import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '@patchwork/fixtures';
import { AnalysisJobSchema, CoverageSchema, createSelectionFootprint, graphSnapshotJsonSchema, GraphSnapshotSchema, SelectionFootprintSchema, type GraphSnapshot } from './index';

const valid: GraphSnapshot = {
  schemaVersion: '1', id: 'snapshot-1', contextSha: '123', contextRef: 'main', createdAt: '2026-11-03T00:00:00Z', mode: 'demo',
  repository: { owner: 'demo', name: 'repo', fullName: 'demo/repo', defaultBranch: 'main', htmlUrl: 'https://github.com/demo/repo' },
  nodes: [
    { id: 'a', path: 'src/a.ts', groupId: 'module', sourceIds: ['pr-1'] },
    { id: 'b', path: 'src/b.ts', groupId: 'module', sourceIds: [] },
  ],
  groups: [{ id: 'module', label: 'Module' }],
  edges: [{ id: 'import-a-b', source: 'a', target: 'b', kind: 'import', evidence: { path: 'src/a.ts', line: 1, specifier: './b' } }],
  sources: [{ id: 'pr-1', kind: 'pr', title: 'Change A', label: '#1', number: 1, baseSha: 'base', headSha: 'head', comparisonKind: 'merge-base', url: 'https://github.com/demo/repo/pull/1', files: [{ fileId: 'a', path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }] }],
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
    const { schemaVersion: _version, ...unversioned } = valid;
    expect(GraphSnapshotSchema.safeParse(unversioned).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, schemaVersion: '999' }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, sources: [{ ...valid.sources[0], files: [{ ...valid.sources[0].files[0], fileId: 'missing' }] }] }).success).toBe(false);
  });

  it('rejects source comparisons without pinned pairs or with incompatible semantics', () => {
    expect(GraphSnapshotSchema.safeParse({ ...valid, sources: [{ ...valid.sources[0], baseSha: undefined }] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, sources: [{ ...valid.sources[0], comparisonKind: 'first-parent' }] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, sources: [{ ...valid.sources[0], kind: 'commit', comparisonKind: 'first-parent', sha: 'different' }] }).success).toBe(false);
  });

  it('rejects contradictory membership and repeated changed-file identities', () => {
    expect(GraphSnapshotSchema.safeParse({ ...valid, nodes: [{ ...valid.nodes[0], sourceIds: [] }, valid.nodes[1]] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, nodes: [valid.nodes[0], { ...valid.nodes[1], sourceIds: ['pr-1'] }] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, sources: [{ ...valid.sources[0], files: [valid.sources[0]!.files[0], valid.sources[0]!.files[0]] }] }).success).toBe(false);
  });

  it('rejects invalid hierarchy and unsafe repository paths', () => {
    expect(GraphSnapshotSchema.safeParse({ ...valid, groups: [{ ...valid.groups[0], parentId: 'missing' }] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, groups: [{ ...valid.groups[0], parentId: 'module' }] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, nodes: [{ ...valid.nodes[0], path: '../outside.ts' }, valid.nodes[1]] }).success).toBe(false);
  });

  it('rejects foreign, unpinned and incorrectly attributed observed import evidence', () => {
    const sha = 'a'.repeat(40);
    const snapshot = { ...valid, mode: 'github', contextSha: sha, sources: [{ ...valid.sources[0], baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) }], edges: [{ ...valid.edges[0], evidence: { path: 'src/a.ts', line: 1, snapshotSha: sha, resolver: 'typescript-v1' } }] };
    expect(GraphSnapshotSchema.safeParse(snapshot).success).toBe(true);
    for (const evidence of [undefined, 'unverified', { path: 'src/a.ts' }, { path: 'src/b.ts', snapshotSha: sha, resolver: 'typescript-v1' }, { path: 'src/a.ts', snapshotSha: 'f'.repeat(40), resolver: 'typescript-v1' }, { path: 'src/a.ts', snapshotSha: sha, resolver: 'typescript-v1', sourceId: 'missing' }]) expect(GraphSnapshotSchema.safeParse({ ...snapshot, edges: [{ ...snapshot.edges[0], evidence }] }).success).toBe(false);
  });

  it('rejects impossible coverage and line counters while retaining explicit unsupported states', () => {
    expect(CoverageSchema.safeParse({ status: 'partial', reasons: [] }).success).toBe(false);
    expect(CoverageSchema.safeParse({ status: 'complete', reasons: [], filesAnalyzed: 5, totalFiles: 4 }).success).toBe(false);
    for (const status of ['partial', 'unsupported', 'failed', 'excluded']) expect(CoverageSchema.safeParse({ status, reasons: ['Reason'], filesAnalyzed: 0, totalFiles: 4 }).success).toBe(true);
    for (const file of [{ ...valid.sources[0]!.files[0], status: 'added', deletions: 1 }, { ...valid.sources[0]!.files[0], status: 'renamed' }, { ...valid.sources[0]!.files[0], status: 'deleted', additions: 1 }]) expect(GraphSnapshotSchema.safeParse({ ...valid, sources: [{ ...valid.sources[0], files: [file] }] }).success).toBe(false);
  });

  it('derives structural JSON Schema from the same runtime schema', () => {
    const schema = graphSnapshotJsonSchema();
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('schemaVersion');
    expect(schema.properties?.schemaVersion).toMatchObject({ const: '1' });
  });
});

describe('selection overlays', () => {
  it('keeps dependency neighbors separate from directly changed files', () => {
    const footprint = createSelectionFootprint(valid, ['pr-1']);
    expect(footprint.counts).toEqual({ changedFiles: 1, overlappingFiles: 0, overlappingSources: 0, dependencyNeighbors: 1 });
    expect(footprint.files).toEqual([{ fileId: 'a', sourceIds: ['pr-1'], directlyChanged: true, dependencyNeighbor: false }, { fileId: 'b', sourceIds: [], directlyChanged: false, dependencyNeighbor: true }]);
    expect(SelectionFootprintSchema.safeParse({ ...footprint, counts: { ...footprint.counts, changedFiles: 2 } }).success).toBe(false);
    expect(() => createSelectionFootprint(valid, ['foreign'])).toThrow('Unknown selected source');
  });
  it('validates canonical 212-file fixture and 68/14 counts without changing its identity', () => {
    const snapshot = createDemoSnapshot(); const original = JSON.stringify(snapshot);
    expect(GraphSnapshotSchema.parse(snapshot).nodes).toHaveLength(212);
    const footprint = createSelectionFootprint(snapshot, ['pr-248', 'pr-251', 'pr-256']);
    expect(footprint.counts.changedFiles).toBe(68); expect(footprint.counts.overlappingFiles).toBe(14);
    expect(createSelectionFootprint(snapshot, ['pr-248', 'pr-251']).counts).toMatchObject({ changedFiles: 57, overlappingFiles: 2 });
    expect(JSON.stringify(snapshot)).toBe(original);
  });
});

describe('analysis job contract', () => {
  const job = { schemaVersion: '1', id: 'job-1', repository: 'demo/repo', status: 'ready', progress: 100, snapshotId: 'snapshot-1', message: 'Ready', createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:01Z' };
  it('rejects invalid terminal states, dates, progress and unversioned payloads', () => {
    expect(AnalysisJobSchema.safeParse(job).success).toBe(true);
    for (const invalid of [{ ...job, schemaVersion: undefined }, { ...job, progress: 101 }, { ...job, snapshotId: undefined }, { ...job, status: 'failed' }, { ...job, updatedAt: '2025-01-01T00:00:00Z' }]) expect(AnalysisJobSchema.safeParse(invalid).success).toBe(false);
  });
});
