import { authoredFileFacts } from '@patchwork/fixtures';
import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '@patchwork/fixtures';
import { deriveRepositoryHierarchy } from '../../analysis/src/groups';
import { AnalysisJobSchema, CoverageSchema, createSelectionFootprint, FileNodeSchema, graphSnapshotJsonSchema, GraphSnapshotSchema, RepositoryHierarchySchema, SelectionFootprintSchema, unparsedFileFacts, type GraphSnapshot } from './index';

const valid: GraphSnapshot = {
  schemaVersion: '1', id: 'snapshot-1', contextSha: '123', contextRef: 'main', createdAt: '2026-11-03T00:00:00Z', mode: 'demo',
  repository: { owner: 'demo', name: 'repo', fullName: 'demo/repo', defaultBranch: 'main', htmlUrl: 'https://github.com/demo/repo' },
  nodes: [
    { ...authoredFileFacts('complete'), id: 'a', path: 'src/a.ts', groupId: 'module', sourceIds: ['pr-1'] },
    { ...authoredFileFacts('complete'), id: 'b', path: 'src/b.ts', groupId: 'module', sourceIds: [] },
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
    expect(GraphSnapshotSchema.safeParse({ ...snapshot, nodes: [{ ...snapshot.nodes[0]!, importCoverage: 'excluded', importReasons: ['No context parsing.'] }, snapshot.nodes[1]!] }).success).toBe(false);
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

describe('canonical per-file inventory facts', () => {
  it('requires honest explicit facts instead of defaulting missing metadata to complete', () => {
    const node = { ...unparsedFileFacts('Source parsing has not run.'), id: 'a', path: 'src/a.ts', groupId: 'module', sourceIds: [] };
    expect(FileNodeSchema.parse(node)).toMatchObject({ fileKind: 'unknown', importCoverage: 'partial', importReasons: ['Source parsing has not run.'] });
    for (const field of ['fileKind', 'presence', 'status', 'importCoverage', 'importReasons', 'externalImports', 'unresolvedImports']) {
      expect(FileNodeSchema.safeParse({ ...node, [field]: undefined }).success, field).toBe(false);
    }
    expect(FileNodeSchema.safeParse({ ...node, importCoverage: 'complete' }).success).toBe(false);
    expect(() => unparsedFileFacts(' ')).toThrow('explicit reason');
  });

  it('rejects malformed classifications, statuses, reasons, sizes and unresolved import metadata', () => {
    const node = valid.nodes[0]!;
    for (const patch of [{ fileKind: 'folder' }, { fileType: 'island' }, { status: 'guessed' }, { presence: 'remote' }, { importCoverage: 'pending' }, { importReasons: [7] }, { importCoverage: 'partial', importReasons: [] }, { size: Infinity }, { size: -1 }, { externalImports: [{ specifier: 'react', line: 0, kind: 'import', reason: 'External' }] }, { unresolvedImports: [{ specifier: './missing', line: 1, kind: 'ai-inferred', reason: 'Unknown' }] }]) expect(FileNodeSchema.safeParse({ ...node, ...patch }).success, JSON.stringify(patch)).toBe(false);
    expect(FileNodeSchema.safeParse({ ...node, unresolvedImports: [{ specifier: './missing', line: 1, kind: 'import', reason: 'No matching file' }] }).success).toBe(false);
    expect(FileNodeSchema.safeParse({ ...node, importCoverage: 'partial', importReasons: ['Unresolved literal import.'], unresolvedImports: [{ specifier: './missing', line: 1, kind: 'import', reason: 'No matching file' }] }).success).toBe(true);
  });
});

describe('selected-head dependency layer boundary', () => {
  const contextSha = 'a'.repeat(40), headSha = 'b'.repeat(40);
  function snapshot(): GraphSnapshot {
    return {
      ...structuredClone(valid), mode: 'github', contextSha,
      nodes: [...structuredClone(valid.nodes), { ...authoredFileFacts('complete'), id: 'new', path: 'src/new.ts', groupId: 'module', presence: 'source-only', sourceIds: ['pr-1'] }],
      edges: [{ ...valid.edges[0]!, provenance: 'context', evidence: { path: 'src/a.ts', line: 1, specifier: './b', resolver: 'ts-v3', snapshotSha: contextSha } }],
      sources: [{
        ...valid.sources[0]!, baseSha: contextSha, headSha,
        files: [{ fileId: 'a', path: 'src/renamed.ts', previousPath: 'src/a.ts', status: 'renamed', additions: 1, deletions: 0 }, { fileId: 'new', path: 'src/new.ts', status: 'added', additions: 1, deletions: 0 }],
        importHeadSha: headSha, importCoverage: { status: 'partial', reasons: ['Outgoing direct-change imports only'], filesAnalyzed: 2, totalFiles: 3 },
        importFiles: [{ fileId: 'a', path: 'src/renamed.ts', status: 'complete', reasons: [] }, { fileId: 'new', path: 'src/new.ts', status: 'complete', reasons: [] }],
        importEdges: [{ id: 'head-edge', source: 'a', target: 'new', kind: 'import', sourceId: 'pr-1', provenance: 'selected-head', evidence: { path: 'src/renamed.ts', line: 2, specifier: './new', resolver: 'ts-v3', sourceId: 'pr-1', snapshotSha: headSha, headSha, contextSha } }],
      }],
    };
  }

  it('accepts a renamed importer and source-only target without changing context evidence', () => {
    const parsed = GraphSnapshotSchema.parse(snapshot());
    expect(parsed.edges[0]!.evidence).toMatchObject({ path: 'src/a.ts', snapshotSha: contextSha });
    expect(parsed.sources[0]!.importEdges![0]!.evidence).toMatchObject({ path: 'src/renamed.ts', snapshotSha: headSha });
  });

  it('rejects foreign source/head/context/path provenance and missing observed evidence', () => {
    for (const patch of [{ sourceId: 'foreign' }, { snapshotSha: contextSha }, { headSha: contextSha }, { contextSha: headSha }, { snapshotId: 'foreign' }, { path: 'src/a.ts' }, { resolver: '' }, { line: undefined }, { specifier: undefined }]) {
      const malformed = snapshot(), edge = malformed.sources[0]!.importEdges![0]!;
      edge.evidence = { ...(typeof edge.evidence === 'object' ? edge.evidence : { path: 'src/renamed.ts' }), ...patch };
      expect(GraphSnapshotSchema.safeParse(malformed).success, JSON.stringify(patch)).toBe(false);
    }
    for (const patch of [{ sourceId: 'foreign' }, { provenance: 'context' }, { source: 'b' }, { target: 'foreign' }, { id: valid.edges[0]!.id }]) {
      const malformed = snapshot(); Object.assign(malformed.sources[0]!.importEdges![0]!, patch);
      expect(GraphSnapshotSchema.safeParse(malformed).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it('rejects malformed layer payloads instead of passing unknown fields through', () => {
    for (const patch of [{ importEdges: 'not-an-array' }, { importFiles: [{}] }, { importHeadSha: contextSha }, { importHeadSha: undefined }, { importCoverage: undefined }, { importCoverage: { status: 'complete', reasons: [], filesAnalyzed: Infinity } }, { importCoverage: { status: 'complete', reasons: [], filesAnalyzed: 4, totalFiles: 3 } }, { importCoverage: { status: 'invented', reasons: [] } }]) {
      const malformed = snapshot(); Object.assign(malformed.sources[0]!, patch);
      expect(GraphSnapshotSchema.safeParse(malformed).success, JSON.stringify(patch)).toBe(false);
    }
    const invalidStatus = snapshot(); Object.assign(invalidStatus.sources[0]!.importFiles![0]!, { status: 'pending' });
    expect(GraphSnapshotSchema.safeParse(invalidStatus).success).toBe(false);
    const missingFile = snapshot(); missingFile.sources[0]!.importFiles!.pop();
    expect(GraphSnapshotSchema.safeParse(missingFile).success).toBe(false);
    const foreignFile = snapshot(); Object.assign(foreignFile.sources[0]!.importFiles![0]!, { fileId: 'b', path: 'src/b.ts' });
    expect(GraphSnapshotSchema.safeParse(foreignFile).success).toBe(false);
    const duplicateFile = snapshot(); duplicateFile.sources[0]!.importFiles![1] = duplicateFile.sources[0]!.importFiles![0]!;
    expect(GraphSnapshotSchema.safeParse(duplicateFile).success).toBe(false);
    const unpinnedEmpty = snapshot(); Object.assign(unpinnedEmpty.sources[0]!, { importHeadSha: undefined, importEdges: [] });
    expect(GraphSnapshotSchema.safeParse(unpinnedEmpty).success).toBe(false);
    const wrongLayer = snapshot(); wrongLayer.edges.push(wrongLayer.sources[0]!.importEdges![0]!);
    expect(GraphSnapshotSchema.safeParse(wrongLayer).success).toBe(false);
  });

  it('keeps explicit budget and failure fallbacks valid without invented edges', () => {
    const budget = snapshot(); Object.assign(budget.sources[0]!, { importHeadSha: undefined, importEdges: undefined, importCoverage: { status: 'partial', reasons: ['Budget reached'] }, importFiles: budget.sources[0]!.importFiles!.map(file => ({ ...file, status: 'partial', reasons: ['Not analyzed in request budget'] })) });
    expect(GraphSnapshotSchema.safeParse(budget).success).toBe(true);
    const failed = snapshot(); Object.assign(failed.sources[0]!, { importHeadSha: undefined, importFiles: undefined, importEdges: [], importCoverage: { status: 'failed', reasons: ['Provider unavailable'] } });
    expect(GraphSnapshotSchema.safeParse(failed).success).toBe(true);
  });
});

describe('nested canonical hierarchy boundary', () => {
  function hierarchy() { return deriveRepositoryHierarchy(['package.json', 'src/a.ts', 'src/b.ts'], { mapping: { version: 1, modules: [{ id: 'src', label: 'Source', paths: ['src'] }], components: [{ id: 'app', label: 'App', moduleIds: ['src'] }] } }); }
  it('validates the authored hierarchy and rejects unversioned or impossible nested data', () => {
    expect(RepositoryHierarchySchema.safeParse(hierarchy()).success).toBe(true);
    for (const patch of [{ schemaVersion: undefined }, { schemaVersion: '2' }, { folders: [{ id: 'root', path: '', directFileCount: Infinity, descendantFileCount: 3 }] }]) expect(RepositoryHierarchySchema.safeParse({ ...hierarchy(), ...patch }).success).toBe(false);
    const wrongCount = hierarchy(); wrongCount.folders[0]!.descendantFileCount++;
    expect(RepositoryHierarchySchema.safeParse(wrongCount).success).toBe(false);
    const foreignGroup = hierarchy(); foreignGroup.memberships[0]!.groupId = 'foreign';
    expect(RepositoryHierarchySchema.safeParse(foreignGroup).success).toBe(false);
    const duplicate = hierarchy(); duplicate.memberships.push(duplicate.memberships[0]!);
    expect(RepositoryHierarchySchema.safeParse(duplicate).success).toBe(false);
    const cyclic = hierarchy(); cyclic.folders[1]!.parentId = cyclic.folders[1]!.id;
    expect(RepositoryHierarchySchema.safeParse(cyclic).success).toBe(false);
    const foreignComponent = hierarchy(); foreignComponent.components[0]!.moduleIds.push('foreign');
    expect(RepositoryHierarchySchema.safeParse(foreignComponent).success).toBe(false);
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

describe('local-git snapshots', () => {
  const sha = 'a'.repeat(40), base = 'b'.repeat(40), head = 'c'.repeat(40);
  const local = {
    ...valid, mode: 'local-git', contextSha: sha,
    repository: { ...valid.repository, owner: 'local', name: 'repo', fullName: 'local/repo', htmlUrl: 'local-git://local/repo' },
    edges: [{ ...valid.edges[0], evidence: { path: 'src/a.ts', line: 1, snapshotSha: sha, resolver: 'typescript-v1' } }],
    sources: [{ ...valid.sources[0], baseSha: base, headSha: head, url: 'local-git://local/repo/pull/1' }],
  } as GraphSnapshot;
  it('accepts opaque local references and keeps the pinned-SHA rules of GitHub mode', () => {
    expect(GraphSnapshotSchema.safeParse(local).success).toBe(true);
    expect(GraphSnapshotSchema.safeParse({ ...local, contextSha: 'main' }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...local, sources: [{ ...local.sources[0], headSha: 'head' }] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...local, edges: [{ ...local.edges[0], evidence: { path: 'src/a.ts' } }] }).success).toBe(false);
  });
  it('never mixes link spaces between modes', () => {
    expect(GraphSnapshotSchema.safeParse({ ...local, repository: { ...local.repository, htmlUrl: 'https://github.com/local/repo' } }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...local, sources: [{ ...local.sources[0], url: 'https://github.com/local/repo/pull/1' }] }).success).toBe(false);
    const github = { ...local, mode: 'github', repository: { ...local.repository, htmlUrl: 'https://github.com/local/repo' }, sources: [{ ...local.sources[0], url: 'https://github.com/local/repo/pull/1' }] };
    expect(GraphSnapshotSchema.safeParse(github).success).toBe(true);
    expect(GraphSnapshotSchema.safeParse({ ...github, repository: { ...github.repository, htmlUrl: 'local-git://local/repo' } }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...github, sources: [{ ...github.sources[0], url: 'local-git://local/repo/pull/1' }] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...valid, sources: [{ ...valid.sources[0], url: 'local-git://demo/repo/pull/1' }] }).success).toBe(false);
  });
  it('rejects local references that could carry a path, host or query', () => {
    for (const htmlUrl of ['local-git:/abs/repo', 'local-git://local/abs/path/repo', 'local-git://local/repo/../x', 'local-git://local/repo?x=1', 'local-git://local/repo/blob/main', 'file:///tmp/repo']) expect(GraphSnapshotSchema.safeParse({ ...local, repository: { ...local.repository, htmlUrl } }).success).toBe(false);
  });
  it('accepts a recorded footprint only in local mode, with origin and incomplete coverage', () => {
    const recorded = { ...local.sources[0], comparisonKind: 'recorded', baseSha: undefined, headSha: head, recordedOrigin: 'export file', coverage: { status: 'partial', reasons: ['Recorded list; no Git comparison.'] } };
    expect(GraphSnapshotSchema.safeParse({ ...local, sources: [recorded] }).success).toBe(true);
    expect(GraphSnapshotSchema.safeParse({ ...local, sources: [{ ...recorded, headSha: undefined }] }).success).toBe(true);
    expect(GraphSnapshotSchema.safeParse({ ...local, sources: [{ ...recorded, recordedOrigin: undefined }] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...local, sources: [{ ...recorded, coverage: { status: 'complete', reasons: [] } }] }).success).toBe(false);
    expect(GraphSnapshotSchema.safeParse({ ...local, sources: [{ ...recorded, headSha: 'not-a-sha' }] }).success).toBe(false);
    const github = { ...local, mode: 'github', repository: { ...local.repository, htmlUrl: 'https://github.com/local/repo' }, sources: [{ ...recorded, url: 'https://github.com/local/repo/pull/1' }] };
    expect(GraphSnapshotSchema.safeParse(github).success).toBe(false);
  });
});
