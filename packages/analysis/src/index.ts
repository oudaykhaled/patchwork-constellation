import { createHash } from 'node:crypto';
import { validateGraphSnapshot, type GraphSnapshot, type ChangeSource, type FileChange, type FileNode, type ChangeStatus } from '@patchwork/contracts';
import { GitHubClient, GitHubError, parseRepository, type GitHubOptions } from '@patchwork/github';
import { deriveGroups, nodeForPath } from './groups';
import { languageFor } from './imports';
import { buildStaticGraph } from './static-graph';
export { extractImports, scanImports, resolveImport, languageFor, isSourceFile, RESOLVER_VERSION } from './imports';
export { buildStaticGraph } from './static-graph';
export { analyzeSourceDependencies, enrichSelectedSourceDependencies } from './source-dependencies';
export { deriveGroups, groupKeyFor, deriveRepositoryHierarchy, applyHierarchy, RepositoryMappingSchema, GROUPING_RULES_VERSION } from './groups';
export type { RepositoryHierarchy, RepositoryMapping, HierarchyOptions, ManifestBoundary } from './groups';

export interface AnalysisProgress { stage: 'fetching' | 'indexing' | 'sources' | 'ready'; progress: number; message: string; }
export interface AnalysisOptions extends GitHubOptions { onProgress?: (progress: AnalysisProgress) => void; maxFiles?: number; maxSourceFiles?: number; sourcePages?: number; }
export interface AnalyzeInput { repository: string; contextRef?: string; mode?: 'pr' | 'commit'; }
interface ApiRepository { name: string; full_name: string; private: boolean; default_branch: string; html_url: string; owner: { login: string }; }
interface ApiCommit { sha: string; html_url?: string; commit: { message: string }; parents: { sha: string }[]; files?: ApiFile[]; }
interface ApiPull { number: number; title: string; html_url: string; state: string; changed_files?: number; base: { sha: string; ref: string }; head: { sha: string; ref: string }; }
interface ApiFile { filename: string; previous_filename?: string; status: string; additions?: number; deletions?: number; sha?: string; }
interface ApiComparison { merge_base_commit: { sha: string }; files?: ApiFile[]; }
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_SELECTION = 20;
export const ANALYZER_VERSION = 'static-v3';
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const unique = (values: string[]) => [...new Set(values)];
const prefixFor = (fullName: string) => `/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`;
const statusFor = (value: string): ChangeStatus => ['added', 'modified', 'removed', 'renamed', 'copied', 'unchanged', 'binary'].includes(value) ? value as ChangeStatus : 'modified';
const supportedRef = (value: string) => value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
function sourceFromPull(pull: ApiPull): ChangeSource {
  return { id: `pr:${pull.number}`, kind: 'pr', number: pull.number, title: pull.title, label: `#${pull.number}`, url: pull.html_url, baseSha: pull.base.sha, headSha: pull.head.sha, comparisonKind: 'merge-base', files: [], loaded: false, state: pull.state };
}
function sourceFromCommit(commit: ApiCommit): ChangeSource {
  return { id: `commit:${commit.sha}`, kind: 'commit', title: commit.commit.message.split('\n')[0] ?? commit.sha, label: commit.sha.slice(0, 7), sha: commit.sha, headSha: commit.sha, baseSha: commit.parents[0]?.sha ?? EMPTY_TREE, comparisonKind: commit.parents.length ? 'first-parent' : 'empty-tree', url: commit.html_url ?? '', files: [], loaded: false, mergeCommit: commit.parents.length > 1 };
}

/** Lists bounded pages without treating a partial picker as the entire history. */
export async function listRepositorySources(repository: string, kind: 'pr' | 'commit', page = 1, contextSha?: string, options: GitHubOptions = {}) {
  const address = parseRepository(repository); const client = new GitHubClient(options); const prefix = prefixFor(address.fullName);
  const metadata = await client.get<ApiRepository>(prefix);
  if (metadata.private) throw new GitHubError('This build analyzes public repositories. Private repository authorization is not configured.', 403, 'PRIVATE_UNSUPPORTED');
  if (kind === 'pr') { const result = await client.page<ApiPull>(`${prefix}/pulls?state=all&sort=updated&direction=desc`, page, 30); return { sources: result.items.map(sourceFromPull), nextPage: result.nextPage }; }
  const result = await client.page<ApiCommit>(`${prefix}/commits${contextSha ? `?sha=${encodeURIComponent(contextSha)}` : ''}`, page, 30);
  return { sources: result.items.map(sourceFromCommit), nextPage: result.nextPage };
}

export async function analyzeRepository(input: AnalyzeInput, options: AnalysisOptions = {}): Promise<GraphSnapshot> {
  const address = parseRepository(input.repository); const client = new GitHubClient(options); const prefix = prefixFor(address.fullName); const reasons: string[] = [];
  let lastProgress = 0;
  const emit = (stage: AnalysisProgress['stage'], progress: number, message: string) => { options.signal?.throwIfAborted(); lastProgress = Math.max(lastProgress, progress); options.onProgress?.({ stage, progress: lastProgress, message }); };
  emit('fetching', 3, 'Resolving the public repository and immutable context');
  const repository = await client.get<ApiRepository>(prefix);
  if (repository.private) throw new GitHubError('This build analyzes public repositories. Private repository authorization is not configured.', 403, 'PRIVATE_UNSUPPORTED');
  const contextRef = input.contextRef?.trim() || repository.default_branch;
  if (!supportedRef(contextRef)) throw new GitHubError('Enter a valid branch name or commit SHA.', 400, 'INVALID_REF');
  const commit = await client.get<ApiCommit>(`${prefix}/commits/${encodeURIComponent(contextRef)}`);
  if (!/^[a-f0-9]{40,64}$/i.test(commit.sha)) throw new GitHubError('GitHub did not return an immutable context SHA.', 502, 'INVALID_RESPONSE');
  emit('fetching', 12, 'Reading the pinned repository tree');
  const staticGraph = await buildStaticGraph(client, address, commit.sha, { maxFiles: options.maxFiles, maxSourceFiles: options.maxSourceFiles, signal: options.signal, onProgress: (analyzed, eligible) => emit('indexing', 24 + Math.round((analyzed / Math.max(eligible, 1)) * 45), `Indexed ${analyzed} source files`) });
  const { nodes, edges, hierarchy, parserLimits } = staticGraph; const groups = hierarchy.groups;
  reasons.push(...staticGraph.coverage.reasons);
  emit('sources', 76, 'Loading recent pull requests and commits');
  const sourceResults = await Promise.allSettled([
    client.page<ApiPull>(`${prefix}/pulls?state=all&sort=updated&direction=desc`, 1, 30),
    client.page<ApiCommit>(`${prefix}/commits?sha=${commit.sha}`, 1, 30),
  ]);
  const sources: ChangeSource[] = []; const sourcePagination: Record<string, number | null> = {};
  sourceResults.forEach((result, index) => {
    const kind = index === 0 ? 'pr' : 'commit';
    if (result.status === 'rejected') { reasons.push(`${kind === 'pr' ? 'Pull request' : 'Commit'} discovery is unavailable. Retry after checking GitHub access/quota.`); sourcePagination[kind] = null; return; }
    const page = result.value;
    sources.push(...(kind === 'pr' ? (page.items as ApiPull[]).map(sourceFromPull) : (page.items as ApiCommit[]).map(sourceFromCommit)));
    sourcePagination[kind] = page.nextPage;
  });
  const snapshot: GraphSnapshot = { schemaVersion: '1', id: `snapshot:${hash(`${repository.full_name}:${commit.sha}:${ANALYZER_VERSION}`)}`, repository: { owner: repository.owner.login, name: repository.name, fullName: repository.full_name, defaultBranch: repository.default_branch, htmlUrl: repository.html_url }, contextSha: commit.sha, contextRef, nodes, edges: edges.sort((a, b) => a.id.localeCompare(b.id)), groups, sources, coverage: { ...staticGraph.coverage, status: reasons.length ? 'partial' : 'complete', reasons: unique(reasons) }, createdAt: new Date().toISOString(), mode: 'github', sourcePagination, analyzerVersion: ANALYZER_VERSION, groupingRevision: hierarchy.revision, hierarchy, parserLimits, defaultSelection: [] };
  emit('ready', 100, `Ready: ${nodes.length} files and ${edges.length} evidenced connections`);
  return validateGraphSnapshot(snapshot);
}

function toChanges(files: ApiFile[], snapshot: GraphSnapshot, sourceId: string): { changes: FileChange[]; nodes: FileNode[] } {
  const pathMap = new Map(snapshot.nodes.map(node => [node.path, node])); const extra: FileNode[] = [];
  const changes = files.map(file => {
    // A reported rename may map to a surviving context path, never an invented fuzzy rename.
    let node = pathMap.get(file.filename) ?? (file.previous_filename ? pathMap.get(file.previous_filename) : undefined);
    // Independent additions with the same path and different blobs are not proven to be one lineage.
    const ambiguousAddition = node?.presence === 'source-only' && file.status === 'added' && typeof node.blobSha === 'string' && file.sha && node.blobSha !== file.sha;
    if (!node || ambiguousAddition) {
      const base = nodeForPath(snapshot.repository.fullName, file.filename);
      const candidateId = ambiguousAddition ? `${base.id}@${file.sha!.slice(0, 12)}` : base.id;
      node = snapshot.nodes.find(item => item.id === candidateId) ?? extra.find(item => item.id === candidateId);
      if (!node) { node = { ...base, id: candidateId, presence: file.status === 'removed' ? 'deleted' : 'source-only', status: statusFor(file.status), language: languageFor(file.filename), sourceIds: [sourceId], importCoverage: 'unsupported', blobSha: file.sha, ...(ambiguousAddition ? { ambiguousLineage: true } : {}) }; extra.push(node); }
      pathMap.set(file.filename, node);
    }
    return { fileId: node.id, path: file.filename, status: statusFor(file.status), additions: Math.max(0, file.additions ?? 0), deletions: Math.max(0, file.deletions ?? 0), ...(file.previous_filename ? { previousPath: file.previous_filename } : {}) };
  });
  return { changes, nodes: extra };
}

export async function loadSourceChanges(snapshot: GraphSnapshot, kind: 'pr' | 'commit', ids: string[], options: AnalysisOptions = {}): Promise<GraphSnapshot> {
  if (kind !== 'pr' && kind !== 'commit') throw new GitHubError('Choose pull requests or commits.', 400, 'INVALID_SOURCE');
  const selection = unique(ids);
  if (selection.length > MAX_SELECTION) throw new GitHubError(`Select up to ${MAX_SELECTION} changes at once.`, 400, 'SELECTION_LIMIT');
  const result = structuredClone(snapshot); const address = parseRepository(snapshot.repository.fullName); const prefix = prefixFor(address.fullName); const client = new GitHubClient(options);
  const reasons = [...result.coverage.reasons];
  for (const [index, id] of selection.entries()) {
    options.signal?.throwIfAborted();
    const source = result.sources.find(item => item.id === id && item.kind === kind);
    if (!source) throw new GitHubError('Selected source is not part of this repository snapshot. Refresh the source list.', 400, 'UNKNOWN_SOURCE');
    if (source.loaded) continue;
    options.onProgress?.({ stage: 'sources', progress: Math.round((index / Math.max(selection.length, 1)) * 100), message: `Loading ${source.label}` });
    let files: ApiFile[] = []; let sourceReasons: string[] = [];
    if (kind === 'pr') {
      if (!source.number || !/^pr:\d+$/.test(id)) throw new GitHubError('Invalid pull request ID.', 400, 'INVALID_SOURCE');
      const pull = await client.get<ApiPull>(`${prefix}/pulls/${source.number}`);
      if ((source.headSha && source.headSha !== pull.head.sha) || (source.baseSha && source.baseSha !== pull.base.sha)) throw new GitHubError('This pull request changed since the snapshot was created. Refresh the repository before applying it.', 409, 'STALE_SOURCE');
      const comparison = await client.get<ApiComparison>(`${prefix}/compare/${pull.base.sha}...${pull.head.sha}?per_page=1`, true);
      files = comparison.files ?? []; source.baseSha = comparison.merge_base_commit.sha; source.headSha = pull.head.sha; source.comparisonKind = 'merge-base';
      if ((pull.changed_files ?? files.length) > files.length || files.length >= 300) {
        files = [];
        for (let page = 1; page <= 30; page++) { const batch = await client.page<ApiFile>(`${prefix}/pulls/${source.number}/files`, page, 100); files.push(...batch.items); if (!batch.nextPage) break; }
        const after = await client.get<ApiPull>(`${prefix}/pulls/${source.number}?state_check=${Date.now()}`);
        if (after.head.sha !== pull.head.sha || after.base.sha !== pull.base.sha) throw new GitHubError('The pull request changed while files were loading. Refresh and retry.', 409, 'STALE_SOURCE');
        if ((pull.changed_files ?? 0) > files.length || files.length >= 3_000) sourceReasons.push(`${source.label}: GitHub's 3,000-file PR limit may truncate this change set.`);
      }
    } else {
      if (!source.sha || !/^[a-f0-9]{40,64}$/i.test(source.sha) || id !== `commit:${source.sha}`) throw new GitHubError('Invalid commit ID.', 400, 'INVALID_SOURCE');
      let metadata: ApiCommit | undefined;
      for (let page = 1; page <= 30; page++) { const commit = await client.get<ApiCommit>(`${prefix}/commits/${source.sha}?per_page=100&page=${page}`, true); metadata ??= commit; files.push(...(commit.files ?? [])); if ((commit.files?.length ?? 0) < 100) break; }
      if (files.length >= 3_000) sourceReasons.push(`${source.label}: GitHub's 3,000-file commit limit may truncate this change set.`);
      source.baseSha = metadata?.parents[0]?.sha ?? EMPTY_TREE; source.headSha = source.sha; source.comparisonKind = metadata?.parents.length ? 'first-parent' : 'empty-tree'; source.mergeCommit = (metadata?.parents.length ?? 0) > 1;
    }
    const canonical = toChanges(files, result, id); source.files = canonical.changes; source.loaded = true; source.coverage = { status: sourceReasons.length ? 'partial' : 'complete', reasons: sourceReasons }; result.nodes.push(...canonical.nodes);
    if (canonical.nodes.length) reasons.push('Selected-source-only files are visible, but import edges describe the pinned context snapshot. Imports from other source heads have not been analyzed.');
    if (canonical.nodes.some(node => node.ambiguousLineage)) reasons.push('Independent selected sources add the same path with different blobs. Separate source-only identities are retained because shared lineage is unproven.');
    reasons.push(...sourceReasons);
  }
  // Retain prior source-only nodes and IDs so returning to a previous selection is stable.
  const membership = new Map<string, Set<string>>();
  for (const source of result.sources) for (const file of source.files) { if (!membership.has(file.fileId)) membership.set(file.fileId, new Set()); membership.get(file.fileId)!.add(source.id); }
  result.nodes = result.nodes.map(node => ({ ...node, sourceIds: [...(membership.get(node.id) ?? [])] }));
  const existingGroups = new Set(result.groups.map(group => group.id));
  result.groups.push(...deriveGroups(result.nodes.map(node => node.path)).filter(group => !existingGroups.has(group.id)));
  result.coverage = { ...result.coverage, status: reasons.length ? 'partial' : 'complete', reasons: unique(reasons) }; result.defaultSelection = selection;
  options.onProgress?.({ stage: 'ready', progress: 100, message: 'Selected change footprints are ready' });
  return validateGraphSnapshot(result);
}
