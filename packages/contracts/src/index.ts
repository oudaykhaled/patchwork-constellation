import { z } from 'zod';

export const CONTRACT_VERSION = '1' as const;
const IdSchema = z.string().min(1);
const TimestampSchema = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp');
const GitShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i, 'Expected immutable Git object SHA');
export const RepositoryPathSchema = z.string().min(1).max(1_024).refine(path => !path.startsWith('/') && !/[:\\\u0000-\u001f\u007f]/.test(path) && !path.split('/').some(segment => segment === '..' || segment === '.' || segment === ''), 'Expected repository-relative path');
const FolderPathSchema = z.union([z.literal(''), RepositoryPathSchema]);
export const CoverageStatusSchema = z.enum(['complete', 'partial', 'unsupported', 'failed', 'excluded']);

export const ChangeStatusSchema = z.enum([
  'added', 'modified', 'deleted', 'removed', 'renamed', 'copied', 'unchanged', 'binary', 'unparsed',
]);
export type ChangeStatus = z.infer<typeof ChangeStatusSchema>;
export const CoverageSchema = z.object({
  status: CoverageStatusSchema,
  reasons: z.array(z.string()),
  filesAnalyzed: z.number().int().nonnegative().optional(),
  totalFiles: z.number().int().nonnegative().optional(),
}).passthrough().superRefine((coverage, ctx) => {
  if (coverage.filesAnalyzed !== undefined && coverage.totalFiles !== undefined && coverage.filesAnalyzed > coverage.totalFiles) ctx.addIssue({ code: 'custom', path: ['filesAnalyzed'], message: 'Analyzed files exceed total files' });
  if (coverage.status !== 'complete' && !coverage.reasons.some(reason => reason.trim())) ctx.addIssue({ code: 'custom', path: ['reasons'], message: 'Incomplete coverage requires a reason' });
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const RepositorySchema = z.object({
  id: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  owner: z.string().min(1),
  name: z.string().min(1),
  fullName: z.string().min(3),
  defaultBranch: z.string().min(1),
  htmlUrl: z.string().url(),
}).passthrough().refine(repository => repository.fullName.toLowerCase() === `${repository.owner}/${repository.name}`.toLowerCase(), { path: ['fullName'], message: 'Repository identity does not match owner/name' });
export type Repository = z.infer<typeof RepositorySchema>;

export const FileNodeSchema = z.object({
  id: z.string().min(1),
  path: RepositoryPathSchema,
  groupId: z.string().min(1),
  language: z.string().optional(),
  fileType: z.enum(['source', 'binary', 'generated', 'symlink', 'submodule', 'other']).optional(),
  ancestry: z.array(z.object({ previousPath: RepositoryPathSchema, previousFileId: IdSchema.optional(), commitSha: GitShaSchema.optional(), confidence: z.enum(['confirmed', 'ambiguous']) })).optional(),
  status: ChangeStatusSchema.optional(),
  presence: z.enum(['context', 'added', 'deleted', 'source-only']).optional(),
  sourceIds: z.array(z.string()),
}).passthrough();
export type FileNode = z.infer<typeof FileNodeSchema>;

const HierarchyEvidenceSchema = z.object({ kind: z.enum(['path-rule', 'manifest', 'repository-mapping']), path: FolderPathSchema, rule: z.string().min(1) }).strict();
export const GroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  component: z.string().optional(),
  color: z.string().optional(),
  origin: z.enum(['rules', 'manifest', 'manual', 'ai']).optional(),
  parentId: z.string().optional(),
  path: FolderPathSchema.optional(),
  fileCount: z.number().int().nonnegative().optional(),
  folderIds: z.array(IdSchema).optional(),
  componentIds: z.array(IdSchema).optional(),
  evidence: z.array(HierarchyEvidenceSchema).optional(),
}).passthrough();
export type Group = z.infer<typeof GroupSchema>;

export const ImportEvidenceSchema = z.union([
  z.string(),
  z.object({
    path: RepositoryPathSchema,
    line: z.number().int().positive().optional(),
    specifier: z.string().optional(),
    snapshotSha: z.string().min(1).optional(),
    snapshotId: IdSchema.optional(),
    sourceId: IdSchema.optional(),
    contextSha: z.string().min(1).optional(),
    headSha: z.string().min(1).optional(),
    resolver: z.string().min(1).optional(),
  }).passthrough(),
]);
export type ImportEvidence = z.infer<typeof ImportEvidenceSchema>;
export const ImportEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  kind: z.enum(['import', 'reexport', 'type-import', 'dynamic-import']),
  direction: z.literal('source-to-target').optional(),
  provenance: z.enum(['context', 'selected-head']).optional(),
  sourceId: IdSchema.optional(),
  evidence: ImportEvidenceSchema.optional(),
}).passthrough();
export type ImportEdge = z.infer<typeof ImportEdgeSchema>;

export const SourceImportFileCoverageSchema = z.object({
  fileId: IdSchema, path: RepositoryPathSchema, status: CoverageStatusSchema, reasons: z.array(z.string()),
}).strict().superRefine((file, ctx) => {
  if (file.status !== 'complete' && !file.reasons.some(reason => reason.trim())) ctx.addIssue({ code: 'custom', path: ['reasons'], message: 'Incomplete file import coverage requires a reason' });
});
export type SourceImportFileCoverage = z.infer<typeof SourceImportFileCoverageSchema>;

export const FileChangeSchema = z.object({
  fileId: z.string().min(1),
  path: RepositoryPathSchema,
  status: ChangeStatusSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  previousPath: RepositoryPathSchema.optional(),
}).passthrough().superRefine((change, ctx) => {
  if (change.status === 'renamed' && !change.previousPath) ctx.addIssue({ code: 'custom', path: ['previousPath'], message: 'Rename requires its previous path' });
  if (change.status === 'added' && change.deletions !== 0) ctx.addIssue({ code: 'custom', path: ['deletions'], message: 'Added file cannot have deleted lines' });
  if ((change.status === 'deleted' || change.status === 'removed') && change.additions !== 0) ctx.addIssue({ code: 'custom', path: ['additions'], message: 'Deleted file cannot have added lines' });
});
export type FileChange = z.infer<typeof FileChangeSchema>;

export const ChangeSourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['pr', 'commit']),
  title: z.string(),
  label: z.string(),
  number: z.number().int().positive().optional(),
  sha: z.string().optional(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  comparisonKind: z.enum(['merge-base', 'first-parent', 'empty-tree']).optional(),
  url: z.string().url(),
  files: z.array(FileChangeSchema),
  coverage: CoverageSchema.optional(),
  importEdges: z.array(ImportEdgeSchema).optional(),
  importCoverage: CoverageSchema.optional(),
  importFiles: z.array(SourceImportFileCoverageSchema).optional(),
  importHeadSha: GitShaSchema.optional(),
}).passthrough();
export type ChangeSource = z.infer<typeof ChangeSourceSchema>;

export const RepositoryHierarchySchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION), rulesVersion: z.string().min(1), revision: IdSchema, mappingVersion: z.literal(1).optional(),
  groups: z.array(GroupSchema),
  folders: z.array(z.object({ id: IdSchema, path: FolderPathSchema, parentId: IdSchema.optional(), directFileCount: z.number().int().nonnegative(), descendantFileCount: z.number().int().nonnegative() }).strict()),
  components: z.array(z.object({ id: IdSchema, label: z.string().min(1), moduleIds: z.array(IdSchema), filePaths: z.array(RepositoryPathSchema), origin: z.literal('manual'), evidence: z.array(HierarchyEvidenceSchema) }).strict()),
  memberships: z.array(z.object({ path: RepositoryPathSchema, folderId: IdSchema, groupId: IdSchema, componentIds: z.array(IdSchema) }).strict()),
  warnings: z.array(z.string()),
}).strict().superRefine((hierarchy, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) fail(`Duplicate hierarchy ${label}`); };
  for (const key of ['groups', 'folders', 'components'] as const) unique(hierarchy[key].map(item => item.id), `${key} identity`);
  unique(hierarchy.folders.map(item => item.path), 'folder path'); unique(hierarchy.memberships.map(item => item.path), 'file membership');
  const groups = new Map(hierarchy.groups.map(item => [item.id, item]));
  const folders = new Map(hierarchy.folders.map(item => [item.id, item]));
  const components = new Map(hierarchy.components.map(item => [item.id, item]));
  const memberships = new Map(hierarchy.memberships.map(item => [item.path, item]));
  const direct = new Map<string, number>(), descendants = new Map<string, number>(), byGroup = new Map<string, number>();
  for (const membership of hierarchy.memberships) {
    if (!groups.has(membership.groupId)) fail('Hierarchy file references unknown group');
    const folder = folders.get(membership.folderId);
    const parentPath = membership.path.includes('/') ? membership.path.slice(0, membership.path.lastIndexOf('/')) : '';
    if (!folder || folder.path !== parentPath) fail('Hierarchy file references wrong physical folder');
    direct.set(membership.folderId, (direct.get(membership.folderId) ?? 0) + 1);
    byGroup.set(membership.groupId, (byGroup.get(membership.groupId) ?? 0) + 1);
    const parts = parentPath ? parentPath.split('/') : [];
    for (let depth = 0; depth <= parts.length; depth++) { const path = parts.slice(0, depth).join('/'); descendants.set(path, (descendants.get(path) ?? 0) + 1); }
    unique(membership.componentIds, 'component membership');
    for (const id of membership.componentIds) if (!components.get(id)?.filePaths.includes(membership.path)) fail('Hierarchy component membership is foreign or asymmetric');
  }
  for (const folder of hierarchy.folders) {
    if (folder.path) {
      const expectedParent = folder.path.includes('/') ? folder.path.slice(0, folder.path.lastIndexOf('/')) : '';
      if (!folder.parentId || folders.get(folder.parentId)?.path !== expectedParent) fail('Hierarchy folder parent is missing, cyclic or non-physical');
    } else if (folder.parentId) fail('Hierarchy root folder cannot have a parent');
    if (folder.directFileCount !== (direct.get(folder.id) ?? 0) || folder.descendantFileCount !== (descendants.get(folder.path) ?? 0)) fail('Hierarchy folder counts disagree with file membership');
  }
  const paths = new Set(hierarchy.folders.map(folder => folder.path));
  for (const path of descendants.keys()) if (!paths.has(path)) fail('Hierarchy is missing an ancestor folder');
  for (const group of hierarchy.groups) {
    if (group.fileCount !== undefined && group.fileCount !== (byGroup.get(group.id) ?? 0)) fail('Hierarchy group count disagrees with file membership');
    if (group.parentId && !groups.has(group.parentId)) fail('Hierarchy group references foreign parent');
    const visited = new Set([group.id]); let parent = group.parentId;
    while (parent) { if (visited.has(parent)) { fail('Cyclic hierarchy group'); break; } visited.add(parent); parent = groups.get(parent)?.parentId; }
    for (const id of group.folderIds ?? []) if (!folders.has(id)) fail('Hierarchy group references foreign folder');
    for (const id of group.componentIds ?? []) if (!components.has(id)) fail('Hierarchy group references foreign component');
  }
  for (const component of hierarchy.components) {
    unique(component.moduleIds, 'component module'); unique(component.filePaths, 'component file');
    for (const id of component.moduleIds) if (!groups.has(id)) fail('Hierarchy component references foreign module');
    for (const path of component.filePaths) if (!memberships.get(path)?.componentIds.includes(component.id)) fail('Hierarchy component file is foreign or asymmetric');
  }
});
export type RepositoryHierarchyData = z.infer<typeof RepositoryHierarchySchema>;

const GraphSnapshotBaseSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  id: z.string().min(1),
  repository: RepositorySchema,
  contextSha: z.string().min(1),
  contextRef: z.string().min(1),
  nodes: z.array(FileNodeSchema),
  edges: z.array(ImportEdgeSchema),
  groups: z.array(GroupSchema),
  hierarchy: RepositoryHierarchySchema.optional(),
  sources: z.array(ChangeSourceSchema),
  coverage: CoverageSchema,
  createdAt: TimestampSchema,
  mode: z.enum(['demo', 'github']),
}).passthrough();

export const GraphSnapshotSchema = GraphSnapshotBaseSchema.superRefine((snapshot, ctx) => {
  const checkUnique = (items: { id: string }[], path: string) => {
    const ids = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (ids.has(item.id)) ctx.addIssue({ code: 'custom', path: [path, index, 'id'], message: `Duplicate ${path} ID: ${item.id}` });
      ids.add(item.id);
    }
    return ids;
  };
  const nodes = checkUnique(snapshot.nodes, 'nodes');
  const groups = checkUnique(snapshot.groups, 'groups');
  const sources = checkUnique(snapshot.sources, 'sources');
  const edgeIds = checkUnique(snapshot.edges, 'edges');
  snapshot.nodes.forEach((node, index) => {
    if (!groups.has(node.groupId)) ctx.addIssue({ code: 'custom', path: ['nodes', index, 'groupId'], message: 'Unknown group reference' });
    if (new Set(node.sourceIds).size !== node.sourceIds.length) ctx.addIssue({ code: 'custom', path: ['nodes', index, 'sourceIds'], message: 'Duplicate source membership' });
    node.sourceIds.forEach((id) => { if (!sources.has(id)) ctx.addIssue({ code: 'custom', path: ['nodes', index, 'sourceIds'], message: `Unknown source reference: ${id}` }); });
  });
  const nodeById = new Map(snapshot.nodes.map(node => [node.id, node]));
  const sourceById = new Map(snapshot.sources.map(source => [source.id, source]));
  const sourceFileIds = new Map(snapshot.sources.map(source => [source.id, new Set(source.files.map(file => file.fileId))]));
  const groupById = new Map(snapshot.groups.map(group => [group.id, group]));
  snapshot.groups.forEach((group, index) => {
    if (!group.parentId) return;
    if (!groups.has(group.parentId)) ctx.addIssue({ code: 'custom', path: ['groups', index, 'parentId'], message: 'Unknown parent group' });
    const seen = new Set([group.id]); let parent = group.parentId;
    while (parent) {
      if (seen.has(parent)) { ctx.addIssue({ code: 'custom', path: ['groups', index, 'parentId'], message: 'Cyclic group hierarchy' }); break; }
      seen.add(parent); parent = groupById.get(parent)?.parentId ?? '';
    }
  });
  if (snapshot.mode === 'github' && !GitShaSchema.safeParse(snapshot.contextSha).success) ctx.addIssue({ code: 'custom', path: ['contextSha'], message: 'Context must be pinned to an immutable SHA' });
  const visiblePaths = new Set(snapshot.nodes.map(node => node.path));
  for (const membership of snapshot.hierarchy?.memberships ?? []) if (!visiblePaths.has(membership.path)) ctx.addIssue({ code: 'custom', path: ['hierarchy', 'memberships'], message: 'Hierarchy contains a foreign file path' });
  snapshot.edges.forEach((edge, index) => {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) ctx.addIssue({ code: 'custom', path: ['edges', index], message: 'Dangling import edge' });
    const evidence = edge.evidence;
    const fail = (message: string) => ctx.addIssue({ code: 'custom', path: ['edges', index, 'evidence'], message });
    if (edge.provenance === 'selected-head' || edge.sourceId || (typeof evidence === 'object' && evidence.sourceId)) fail('Selected-head imports must stay in their source layer');
    if (snapshot.mode === 'github' && (!evidence || typeof evidence === 'string' || !evidence.snapshotSha || !evidence.resolver)) fail('Observed import requires pinned evidence and resolver');
    if (evidence && typeof evidence !== 'string') {
      if (evidence.snapshotId && evidence.snapshotId !== snapshot.id) fail('Foreign snapshot evidence');
      const source = evidence.sourceId ? sourceById.get(evidence.sourceId) : undefined;
      if (nodeById.get(edge.source)?.path !== evidence.path && !source?.files.some(file => file.fileId === edge.source && file.path === evidence.path)) fail('Evidence path must identify the importing file');
      if (evidence.sourceId && !source) fail('Unknown source evidence');
      if (evidence.snapshotSha && evidence.snapshotSha !== (source ? source.headSha : snapshot.contextSha)) fail('Foreign or unpinned evidence SHA');
      if (evidence.contextSha && evidence.contextSha !== snapshot.contextSha) fail('Foreign context evidence SHA');
      if (evidence.headSha && evidence.headSha !== snapshot.contextSha) fail('Source-head evidence cannot be used as context evidence');
    }
  });
  snapshot.sources.forEach((source, index) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', path: ['sources', index], message });
    if (!source.baseSha || !source.headSha || !source.comparisonKind) fail('Source comparison requires exact base/head and comparison kind');
    if (snapshot.mode === 'github' && (!GitShaSchema.safeParse(source.baseSha).success || !GitShaSchema.safeParse(source.headSha).success)) fail('Source comparison must use immutable SHAs');
    if (source.kind === 'pr' && source.comparisonKind !== 'merge-base') fail('Pull request requires merge-base comparison');
    if (source.kind === 'commit' && (!['first-parent', 'empty-tree'].includes(source.comparisonKind ?? '') || !source.sha || source.sha !== source.headSha)) fail('Commit requires parent/commit comparison');
    const fileIds = new Set<string>();
    source.files.forEach((file, fileIndex) => {
      if (!nodes.has(file.fileId)) ctx.addIssue({ code: 'custom', path: ['sources', index, 'files', fileIndex, 'fileId'], message: 'Unknown changed-file reference' });
      if (fileIds.has(file.fileId)) fail('Duplicate changed-file identity within source');
      fileIds.add(file.fileId);
      if (!nodeById.get(file.fileId)?.sourceIds.includes(source.id)) fail('Source change missing from node membership');
    });
    const hasImportMetadata = source.importEdges !== undefined || source.importFiles !== undefined || source.importHeadSha !== undefined;
    if (hasImportMetadata && !source.importCoverage) fail('Source-head layer requires explicit import coverage');
    if (source.importHeadSha && source.importHeadSha !== source.headSha) fail('Source-head layer belongs to a different pinned head');
    if (!source.importHeadSha && (source.importCoverage?.status === 'complete' || source.importFiles?.some(file => file.status === 'complete'))) fail('Completed source-head analysis requires a pinned head even when no imports are found');
    const changes = new Map(source.files.map(file => [file.fileId, file]));
    const importFiles = new Map((source.importFiles ?? []).map(file => [file.fileId, file]));
    if (source.importFiles) {
      if (importFiles.size !== source.importFiles.length) fail('Duplicate source-head file coverage');
      if (importFiles.size !== changes.size) fail('Source-head file coverage must describe every changed file exactly once');
      for (const file of source.importFiles) if (!changes.has(file.fileId) || changes.get(file.fileId)!.path !== file.path) fail('Source-head file coverage contains a foreign file identity/path');
    }
    if (source.importEdges?.length && (!source.importHeadSha || !source.importFiles || !source.importCoverage || ['failed', 'unsupported', 'excluded'].includes(source.importCoverage.status))) fail('Observed source-head imports require pinned per-file coverage');
    for (const edge of source.importEdges ?? []) {
      if (edgeIds.has(edge.id)) fail('Duplicate import edge identity across layers'); edgeIds.add(edge.id);
      if (!nodes.has(edge.source) || !nodes.has(edge.target)) fail('Dangling source-head import edge');
      const changed = changes.get(edge.source), file = importFiles.get(edge.source), evidence = edge.evidence;
      if (!changed || ['deleted', 'removed'].includes(changed.status) || !file || !['complete', 'partial'].includes(file.status)) fail('Source-head importer is not an analyzed directly changed file');
      if (edge.provenance !== 'selected-head' || edge.sourceId !== source.id) fail('Source-head edge has foreign or unsupported provenance');
      if (!evidence || typeof evidence === 'string') { fail('Source-head edge requires object evidence'); continue; }
      if (evidence.sourceId !== source.id || evidence.snapshotSha !== source.headSha || evidence.headSha !== source.headSha || evidence.contextSha !== snapshot.contextSha || evidence.path !== changed?.path || !evidence.resolver || !evidence.line || !evidence.specifier) fail('Source-head edge evidence must identify its exact importer, resolver, source, head and context');
      if (evidence.snapshotId && evidence.snapshotId !== snapshot.id) fail('Source-head edge contains a foreign snapshot ID');
    }
  });
  snapshot.nodes.forEach((node, index) => node.sourceIds.forEach(sourceId => {
    if (sources.has(sourceId) && !sourceFileIds.get(sourceId)!.has(node.id)) ctx.addIssue({ code: 'custom', path: ['nodes', index, 'sourceIds'], message: 'Node membership missing from source change list' });
  }));
});

export type GraphSnapshot = z.infer<typeof GraphSnapshotBaseSchema>;
export function validateGraphSnapshot(input: unknown): GraphSnapshot {
  return GraphSnapshotSchema.parse(input);
}

export interface SelectionFootprint {
  fileIds: Set<string>;
  overlapIds: Set<string>;
  sourceIdsByFile: Map<string, string[]>;
  affectedGroupIds: Set<string>;
}

/** Serializable overlay; dependency neighbors are never counted as directly changed files. */
export const SelectionFootprintSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  snapshotId: IdSchema,
  selectedSourceIds: z.array(IdSchema),
  affectedGroupIds: z.array(IdSchema),
  files: z.array(z.object({ fileId: IdSchema, sourceIds: z.array(IdSchema), directlyChanged: z.boolean(), dependencyNeighbor: z.boolean() })),
  counts: z.object({ changedFiles: z.number().int().nonnegative(), overlappingFiles: z.number().int().nonnegative(), overlappingSources: z.number().int().nonnegative(), dependencyNeighbors: z.number().int().nonnegative() }),
}).superRefine((footprint, ctx) => {
  const selected = new Set(footprint.selectedSourceIds);
  const ids = new Set<string>(); const overlappingSources = new Set<string>();
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (selected.size !== footprint.selectedSourceIds.length || new Set(footprint.affectedGroupIds).size !== footprint.affectedGroupIds.length) fail('Duplicate overlay references');
  for (const file of footprint.files) {
    if (ids.has(file.fileId)) fail('Duplicate footprint file'); ids.add(file.fileId);
    if (new Set(file.sourceIds).size !== file.sourceIds.length || file.sourceIds.some(id => !selected.has(id))) fail('Invalid selected-source membership');
    if (file.directlyChanged !== (file.sourceIds.length > 0) || file.dependencyNeighbor === file.directlyChanged) fail('Direct changes and dependency neighbors must remain distinct');
    if (file.sourceIds.length > 1) file.sourceIds.forEach(id => overlappingSources.add(id));
  }
  if (footprint.counts.changedFiles !== footprint.files.filter(file => file.directlyChanged).length || footprint.counts.overlappingFiles !== footprint.files.filter(file => file.sourceIds.length > 1).length || footprint.counts.overlappingSources !== overlappingSources.size || footprint.counts.dependencyNeighbors !== footprint.files.filter(file => file.dependencyNeighbor).length) fail('Footprint counts disagree with file membership');
});
export type SelectionFootprintData = z.infer<typeof SelectionFootprintSchema>;

export function createSelectionFootprint(snapshot: GraphSnapshot, selectedSourceIds: readonly string[]): SelectionFootprintData {
  const selected = [...new Set(selectedSourceIds)].sort();
  const sources = new Map(snapshot.sources.map(source => [source.id, source]));
  if (selected.some(id => !sources.has(id))) throw new Error('Unknown selected source');
  const membership = new Map<string, Set<string>>();
  for (const id of selected) for (const file of sources.get(id)!.files) {
    const ids = membership.get(file.fileId) ?? new Set<string>(); ids.add(id); membership.set(file.fileId, ids);
  }
  const neighbors = new Set<string>();
  for (const edge of snapshot.edges) {
    if (membership.has(edge.source) && !membership.has(edge.target)) neighbors.add(edge.target);
    if (membership.has(edge.target) && !membership.has(edge.source)) neighbors.add(edge.source);
  }
  const files = snapshot.nodes.filter(node => membership.has(node.id) || neighbors.has(node.id)).map(node => ({ fileId: node.id, sourceIds: [...(membership.get(node.id) ?? [])].sort(), directlyChanged: membership.has(node.id), dependencyNeighbor: neighbors.has(node.id) })).sort((a, b) => a.fileId.localeCompare(b.fileId));
  const overlap = files.filter(file => file.sourceIds.length > 1);
  return SelectionFootprintSchema.parse({
    schemaVersion: CONTRACT_VERSION, snapshotId: snapshot.id, selectedSourceIds: selected,
    affectedGroupIds: [...new Set(snapshot.nodes.filter(node => membership.has(node.id)).map(node => node.groupId))].sort(), files,
    counts: { changedFiles: membership.size, overlappingFiles: overlap.length, overlappingSources: new Set(overlap.flatMap(file => file.sourceIds)).size, dependencyNeighbors: neighbors.size },
  });
}

/** Shared wire contract; stores may additionally carry lease/attempt metadata. */
export const AnalysisJobSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION), id: IdSchema,
  repository: z.string().regex(/^[^/]+\/[^/]+$/), contextRef: z.string().min(1).optional(), contextSha: GitShaSchema.optional(),
  status: z.enum(['queued', 'running', 'fetching', 'indexing', 'grouping', 'ready', 'partial', 'failed', 'cancelled']),
  progress: z.number().finite().min(0).max(100), message: z.string(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
  snapshotId: IdSchema.optional(), error: z.string().optional(), coverage: CoverageSchema.optional(),
}).passthrough().superRefine((job, ctx) => {
  if ((job.status === 'ready' || job.status === 'partial') && (!job.snapshotId || job.progress !== 100)) ctx.addIssue({ code: 'custom', message: 'Completed analysis requires a snapshot and 100% progress' });
  if (job.status === 'failed' && !job.error) ctx.addIssue({ code: 'custom', path: ['error'], message: 'Failed analysis requires an error' });
  if (Date.parse(job.updatedAt) < Date.parse(job.createdAt)) ctx.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Job update predates creation' });
});
export type AnalysisJob = z.infer<typeof AnalysisJobSchema>;

/** Generated structural JSON Schema; runtime schemas additionally enforce cross-reference invariants. */
export function graphSnapshotJsonSchema() { return z.toJSONSchema(GraphSnapshotSchema); }

export interface ApiError {
  error: string;
  code?: string;
  retryAfter?: number;
}
