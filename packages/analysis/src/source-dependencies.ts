import { createHash } from 'node:crypto';
import { CoverageStatusSchema, type ChangeSource, type Coverage, type GraphSnapshot, type ImportEdge, type SourceImportFileCoverage } from '@patchwork/contracts';
import { GitHubClient, parseRepository, type GitHubOptions } from '@patchwork/github';
import { buildStaticGraph } from './static-graph';

export interface SourceDependencyResult {
  schemaVersion: '1'; sourceId: string; headSha: string; contextSha: string;
  edges: ImportEdge[]; coverage: Coverage;
  files: SourceImportFileCoverage[];
}
/**
 * An independent source-head layer, not a merged graph. Only direct-change outgoing
 * imports are parsed. Stable file IDs come from confirmed source footprints; unchanged
 * context targets are reused only when the blob hash is identical at the source head.
 */
export async function analyzeSourceDependencies(snapshot: GraphSnapshot, source: ChangeSource, options: GitHubOptions & { maxFiles?: number; maxSourceFiles?: number } = {}): Promise<SourceDependencyResult> {
  if (!source.loaded || !source.headSha || !/^[a-f0-9]{40,64}$/i.test(source.headSha)) throw new Error('Source dependencies require a loaded footprint and immutable head SHA.');
  const graph = await buildStaticGraph(new GitHubClient(options), parseRepository(snapshot.repository.fullName), source.headSha, { maxFiles: options.maxFiles, maxSourceFiles: options.maxSourceFiles ?? 40, maxManifests: 20, signal: options.signal, parsePaths: new Set(source.files.filter(file => file.status !== 'removed' && file.status !== 'deleted').map(file => file.path)) });
  const graphNodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const resultNodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  const changedIds = new Map(source.files.map(file => [file.path, file.fileId]));
  const contextByPath = new Map<string, GraphSnapshot['nodes']>();
  for (const node of snapshot.nodes) {
    const values = contextByPath.get(node.path) ?? []; values.push(node); contextByPath.set(node.path, values);
  }
  const canonicalId = (headNodeId: string): string | undefined => {
    const node = graphNodeById.get(headNodeId); if (!node) return undefined;
    const changedId = changedIds.get(node.path);
    if (changedId && resultNodes.has(changedId)) return changedId;
    const matching = contextByPath.get(node.path)?.filter(candidate => candidate.blobSha === node.blobSha && typeof candidate.blobSha === 'string' && candidate.ambiguousLineage !== true) ?? [];
    return matching.length === 1 ? matching[0]!.id : undefined;
  };
  let unresolvedIdentities = 0; const edges: ImportEdge[] = []; const identityReasons = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const from = canonicalId(edge.source), to = canonicalId(edge.target);
    if (!from || !to) {
      unresolvedIdentities++;
      const path = graphNodeById.get(edge.source)!.path;
      const reasons = identityReasons.get(path) ?? []; reasons.push(`Import target ${graphNodeById.get(edge.target)!.path} has no confirmed identity in the context/source footprint; no edge is guessed.`); identityReasons.set(path, reasons);
      continue;
    }
    edges.push({ ...edge, id: `source-edge:${createHash('sha256').update(`${source.id}:${source.headSha}:${edge.id}:${from}:${to}`).digest('hex').slice(0, 20)}`, source: from, target: to, sourceId: source.id, provenance: 'selected-head', evidence: { path: graphNodeById.get(edge.source)!.path, ...(typeof edge.evidence === 'object' ? edge.evidence : {}), sourceId: source.id, snapshotSha: source.headSha, contextSha: snapshot.contextSha, headSha: source.headSha } });
  }
  const reasons = [...graph.coverage.reasons, 'Source-head dependency analysis covers outgoing imports of directly changed files only; it is not a merged code state or a complete source-head graph.'];
  if (unresolvedIdentities) reasons.push(`${unresolvedIdentities} source-head edges have targets without confirmed context/source identity and are omitted rather than guessing lineage.`);
  const headByPath = new Map(graph.nodes.map(node => [node.path, node]));
  const files: SourceImportFileCoverage[] = source.files.map(file => {
    const node = headByPath.get(file.path);
    if (file.status === 'removed' || file.status === 'deleted') return { fileId: file.fileId, path: file.path, status: 'excluded', reasons: ['Deleted file has no source-head blob; inspect context/base evidence separately.'] };
    return { fileId: file.fileId, path: file.path, status: identityReasons.has(file.path) ? 'partial' : CoverageStatusSchema.safeParse(node?.importCoverage).data ?? 'partial', reasons: [...(Array.isArray(node?.importReasons) ? node.importReasons as string[] : ['File is outside the bounded source-head inventory.']), ...(identityReasons.get(file.path) ?? [])] };
  });
  return { schemaVersion: '1', sourceId: source.id, headSha: source.headSha, contextSha: snapshot.contextSha, edges, coverage: { ...graph.coverage, status: 'partial', reasons }, files };
}

/** Bounded optional enrichment; a failed layer never discards an exact footprint. */
export async function enrichSelectedSourceDependencies(snapshot: GraphSnapshot, kind: 'pr' | 'commit', ids: string[], options: GitHubOptions & { maxFiles?: number; maxSourceFiles?: number; maxSourceHeads?: number } = {}): Promise<GraphSnapshot> {
  const selected = snapshot.sources.filter(source => source.kind === kind && ids.includes(source.id) && source.loaded);
  const limit = Math.min(Math.max(options.maxSourceHeads ?? 3, 0), 20);
  const perHeadBudget = Math.max(0, Math.floor((options.maxSourceFiles ?? 120) / Math.max(1, Math.min(selected.length, limit))));
  const reasons = [...snapshot.coverage.reasons];
  let started = 0;
  for (const source of selected) {
    options.signal?.throwIfAborted();
    if (source.importHeadSha === source.headSha && Array.isArray(source.importEdges)) continue;
    if (started >= limit) {
      source.importCoverage = { status: 'partial', reasons: ['Source-head dependency budget reached. The exact changed-file footprint remains available.'] };
      source.importFiles = source.files.map(file => ({ fileId: file.fileId, path: file.path, status: 'partial', reasons: ['Source-head imports were not analyzed within this request budget.'] }));
      reasons.push(`Source-head dependency layers are limited to ${limit} heads in this request; additional selected sources retain exact footprints with explicit unparsed import coverage.`);
      continue;
    }
    started++;
    try {
      const result = await analyzeSourceDependencies(snapshot, source, { ...options, maxSourceFiles: perHeadBudget });
      source.importEdges = result.edges; source.importCoverage = result.coverage; source.importFiles = result.files; source.importHeadSha = result.headSha;
      reasons.push('Selected-head dependency layers are separate from the pinned context and cover outgoing imports of directly changed files only.');
    } catch (error) {
      if (options.signal?.aborted) throw error;
      source.importEdges = []; source.importCoverage = { status: 'failed', reasons: ['The selected-head dependency layer is unavailable. Its exact changed-file footprint and pinned context are retained.'] };
      reasons.push(`${source.label}: selected-head dependency extraction failed; context edges remain available.`);
    }
  }
  snapshot.coverage = { ...snapshot.coverage, status: reasons.length ? 'partial' : 'complete', reasons: [...new Set(reasons)] };
  return snapshot;
}
