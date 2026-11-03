import { z } from 'zod';


export const ChangeStatusSchema = z.enum([
  'added', 'modified', 'deleted', 'removed', 'renamed', 'copied', 'unchanged', 'binary', 'unparsed',
]);
export type ChangeStatus = z.infer<typeof ChangeStatusSchema>;
export const CoverageSchema = z.object({
  status: z.enum(['complete', 'partial', 'unsupported', 'failed', 'excluded']),
  reasons: z.array(z.string()),
  filesAnalyzed: z.number().int().nonnegative().optional(),
  totalFiles: z.number().int().nonnegative().optional(),
}).passthrough();
export type Coverage = z.infer<typeof CoverageSchema>;

export const RepositorySchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  fullName: z.string().min(3),
  defaultBranch: z.string().min(1),
  htmlUrl: z.string().url(),
}).passthrough();
export type Repository = z.infer<typeof RepositorySchema>;

export const FileNodeSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  groupId: z.string().min(1),
  language: z.string().optional(),
  status: ChangeStatusSchema.optional(),
  presence: z.enum(['context', 'added', 'deleted', 'source-only']).optional(),
  sourceIds: z.array(z.string()),
}).passthrough();
export type FileNode = z.infer<typeof FileNodeSchema>;

export const GroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  component: z.string().optional(),
  color: z.string().optional(),
  origin: z.enum(['rules', 'manifest', 'manual', 'ai']).optional(),
  parentId: z.string().optional(),
}).passthrough();
export type Group = z.infer<typeof GroupSchema>;

export const ImportEvidenceSchema = z.union([
  z.string(),
  z.object({
    path: z.string(),
    line: z.number().int().positive().optional(),
    specifier: z.string().optional(),
    snapshotSha: z.string().optional(),
    resolver: z.string().optional(),
  }).passthrough(),
]);
export type ImportEvidence = z.infer<typeof ImportEvidenceSchema>;
export const ImportEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  kind: z.enum(['import', 'reexport', 'type-import', 'dynamic-import']),
  evidence: ImportEvidenceSchema.optional(),
}).passthrough();
export type ImportEdge = z.infer<typeof ImportEdgeSchema>;

export const FileChangeSchema = z.object({
  fileId: z.string().min(1),
  path: z.string().min(1),
  status: ChangeStatusSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  previousPath: z.string().optional(),
}).passthrough();
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
}).passthrough();
export type ChangeSource = z.infer<typeof ChangeSourceSchema>;

const GraphSnapshotBaseSchema = z.object({
  schemaVersion: z.literal('1').optional(),
  id: z.string().min(1),
  repository: RepositorySchema,
  contextSha: z.string().min(1),
  contextRef: z.string().min(1),
  nodes: z.array(FileNodeSchema),
  edges: z.array(ImportEdgeSchema),
  groups: z.array(GroupSchema),
  sources: z.array(ChangeSourceSchema),
  coverage: CoverageSchema,
  createdAt: z.string(),
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
  checkUnique(snapshot.edges, 'edges');
  snapshot.nodes.forEach((node, index) => {
    if (!groups.has(node.groupId)) ctx.addIssue({ code: 'custom', path: ['nodes', index, 'groupId'], message: 'Unknown group reference' });
    if (new Set(node.sourceIds).size !== node.sourceIds.length) ctx.addIssue({ code: 'custom', path: ['nodes', index, 'sourceIds'], message: 'Duplicate source membership' });
    node.sourceIds.forEach((id) => { if (!sources.has(id)) ctx.addIssue({ code: 'custom', path: ['nodes', index, 'sourceIds'], message: `Unknown source reference: ${id}` }); });
  });
  snapshot.edges.forEach((edge, index) => {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) ctx.addIssue({ code: 'custom', path: ['edges', index], message: 'Dangling import edge' });
  });
  snapshot.sources.forEach((source, index) => source.files.forEach((file, fileIndex) => {
    if (!nodes.has(file.fileId)) ctx.addIssue({ code: 'custom', path: ['sources', index, 'files', fileIndex, 'fileId'], message: 'Unknown changed-file reference' });
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

export interface ApiError {
  error: string;
  code?: string;
  retryAfter?: number;
}

