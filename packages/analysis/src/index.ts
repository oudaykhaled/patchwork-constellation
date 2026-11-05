import { createHash } from 'node:crypto';
import { validateGraphSnapshot, type GraphSnapshot, type ChangeSource } from '@patchwork/contracts';
import { GitHubClient, GitHubError, parseRepository, type GitHubOptions } from '@patchwork/github';
import { deriveGroups, nodeForPath } from './groups';
import { languageFor } from './imports';
import { buildStaticGraph } from './static-graph';
import { ANALYZER_VERSION } from './incremental';
export { extractImports, scanImports, resolveImport, languageFor, isSourceFile, RESOLVER_VERSION, PARSER_VERSION } from './imports';
export { ANALYZER_VERSION, createIncrementalAnalysisBaseline } from './incremental';
export { buildStaticGraph } from './static-graph';
export { analyzeSourceDependencies, enrichSelectedSourceDependencies } from './source-dependencies';
export { deriveGroups, groupKeyFor, deriveRepositoryHierarchy, applyHierarchy, RepositoryMappingSchema, GROUPING_RULES_VERSION } from './groups';
export type { RepositoryHierarchy, RepositoryMapping, HierarchyOptions, ManifestBoundary } from './groups';

export interface AnalysisProgress { stage: 'fetching' | 'indexing' | 'sources' | 'ready'; progress: number; message: string; }
export interface AnalysisOptions extends GitHubOptions { onProgress?: (progress: AnalysisProgress) => void; maxFiles?: number; maxSourceFiles?: number; sourcePages?: number; /** Server-only projection of an authorized stored snapshot. Never a public request input. */ incrementalBaseline?: unknown; gitFallback?: (input: import('./git-fallback').GitDiffRequest) => Promise<import('./git-fallback').GitDiffFile[]>; gitComparisonFallback?: (input: import('./git-fallback').GitDiffRequest) => Promise<import('./git-fallback').GitDiffComparison>; }
export interface AnalyzeInput { repository: string; contextRef?: string; mode?: 'pr' | 'commit'; }
interface ApiRepository { name: string; full_name: string; private: boolean; default_branch: string; html_url: string; owner: { login: string }; }
interface ApiCommit { sha: string; html_url?: string; commit: { message: string }; parents: { sha: string }[]; files?: ApiFile[]; }
interface ApiPull { number: number; title: string; html_url: string; state: string; changed_files?: number; base: { sha: string; ref: string }; head: { sha: string; ref: string }; }
interface ApiFile { filename: string; previous_filename?: string; status: string; additions?: number; deletions?: number; sha?: string; }
interface ApiComparison { merge_base_commit: { sha: string }; files?: ApiFile[]; }
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const unique = (values: string[]) => [...new Set(values)];
const prefixFor = (fullName: string) => `/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`;
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
  if (metadata.private && !(options.allowPrivate && options.token)) throw new GitHubError('Private repository authorization is not configured. Sign in through the GitHub App.', 403, 'PRIVATE_UNSUPPORTED');
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
  if (repository.private && !(options.allowPrivate && options.token)) throw new GitHubError('Private repository authorization is not configured. Sign in through the GitHub App.', 403, 'PRIVATE_UNSUPPORTED');
  const contextRef = input.contextRef?.trim() || repository.default_branch;
  if (!supportedRef(contextRef)) throw new GitHubError('Enter a valid branch name or commit SHA.', 400, 'INVALID_REF');
  const commit = await client.get<ApiCommit>(`${prefix}/commits/${encodeURIComponent(contextRef)}`);
  if (!/^[a-f0-9]{40,64}$/i.test(commit.sha)) throw new GitHubError('GitHub did not return an immutable context SHA.', 502, 'INVALID_RESPONSE');
  emit('fetching', 12, 'Reading the pinned repository tree');
  const staticGraph = await buildStaticGraph(client, address, commit.sha, { maxFiles: options.maxFiles, maxSourceFiles: options.maxSourceFiles, signal: options.signal, incrementalBaseline: options.incrementalBaseline, onProgress: (analyzed, eligible, incremental) => emit('indexing', 24 + Math.round((analyzed / Math.max(eligible, 1)) * 45), `Indexed ${analyzed} source files; reused ${incremental.reusedFiles} unchanged blobs`) });
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
  const snapshot: GraphSnapshot = { schemaVersion: '1', id: `snapshot:${hash(`${repository.full_name}:${commit.sha}:${ANALYZER_VERSION}`)}`, repository: { owner: repository.owner.login, name: repository.name, fullName: repository.full_name, defaultBranch: repository.default_branch, htmlUrl: repository.html_url }, contextSha: commit.sha, contextRef, nodes, edges: edges.sort((a, b) => a.id.localeCompare(b.id)), groups, sources, coverage: { ...staticGraph.coverage, status: reasons.length ? 'partial' : 'complete', reasons: unique(reasons) }, createdAt: new Date().toISOString(), mode: 'github', sourcePagination, analyzerVersion: ANALYZER_VERSION, groupingRevision: hierarchy.revision, hierarchy, parserLimits, incremental: staticGraph.incremental, defaultSelection: [] };
  emit('ready', 100, `Ready: ${nodes.length} files and ${edges.length} evidenced connections`);
  return validateGraphSnapshot(snapshot);
}

export { loadSourceChanges } from './footprints';
export { analyzeLocalRepository, listLocalRepositorySources, loadLocalSourceChanges, pinLocalAnalysisInput, resolveLocalCommit, runLocalGit, LocalSnapshotReader, LocalGitError, LOCAL_GIT_SUBCOMMANDS, LOCAL_REF_PATTERN } from './local-git';
export { observeGitProcesses } from './git-processes';
export type { GitProcessObserver } from './git-processes';
export { currentLocalGitRegistry, loadLocalGitConfig, loadLocalGitRegistry, localGitConfigPath, localGitOnly, normalizeFootprints, publicLocalConfig, LocalConfigError, LOCAL_LIMIT_CEILINGS, LOCAL_LIMIT_DEFAULTS } from './local-git-config';
export type { LocalGitRegistry, LocalRepository, LocalLimits, LocalFootprints, FootprintRecord, PublicLocalConfig } from './local-git-config';
export { githubSnapshotReader, pathPattern } from './static-graph';
export type { SnapshotReader, PathFilter } from './static-graph';
