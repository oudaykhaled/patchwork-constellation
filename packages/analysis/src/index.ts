import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { validateGraphSnapshot, type GraphSnapshot, type ChangeSource, type ImportEdge } from '@patchwork/contracts';
import { GitHubClient, GitHubError, parseRepository, type GitHubOptions } from '@patchwork/github';
import { deriveGroups, groupKeyFor, nodeForPath } from './groups';
import { extractImports, isSourceFile, languageFor, resolveImport, type ResolverOptions } from './imports';
export { extractImports, resolveImport, languageFor, isSourceFile } from './imports';
export { deriveGroups, groupKeyFor, deriveRepositoryHierarchy, applyHierarchy, RepositoryMappingSchema, GROUPING_RULES_VERSION } from './groups';
export type { RepositoryHierarchy, RepositoryMapping, HierarchyOptions, ManifestBoundary } from './groups';

export interface AnalysisProgress { stage: 'fetching' | 'indexing' | 'sources' | 'ready'; progress: number; message: string; }
export interface AnalysisOptions extends GitHubOptions { onProgress?: (progress: AnalysisProgress) => void; maxFiles?: number; maxSourceFiles?: number; sourcePages?: number; gitFallback?: (input: import('./git-fallback').GitDiffRequest) => Promise<import('./git-fallback').GitDiffFile[]>; }
export interface AnalyzeInput { repository: string; contextRef?: string; mode?: 'pr' | 'commit'; }
interface ApiRepository { name: string; full_name: string; private: boolean; default_branch: string; html_url: string; owner: { login: string }; }
interface ApiCommit { sha: string; html_url?: string; commit: { message: string }; parents: { sha: string }[]; files?: ApiFile[]; }
interface ApiPull { number: number; title: string; html_url: string; state: string; changed_files?: number; base: { sha: string; ref: string }; head: { sha: string; ref: string }; }
interface ApiTreeEntry { path: string; type: 'blob' | 'tree' | 'commit'; mode: string; sha: string; size?: number; }
interface ApiFile { filename: string; previous_filename?: string; status: string; additions?: number; deletions?: number; sha?: string; }
interface ApiComparison { merge_base_commit: { sha: string }; files?: ApiFile[]; }
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_FILES = 2_000;
const MAX_PARSE_FILES = 120;
const ANALYZER_VERSION = 'static-v2';
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const unique = (values: string[]) => [...new Set(values)];
const prefixFor = (fullName: string) => `/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`;
const supportedRef = (value: string) => value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
async function mapLimit<T, R>(items: T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  let next = 0; const results: R[] = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await run(items[index]!, index); } }));
  return results;
}
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
  const tree = await client.get<{ tree: ApiTreeEntry[]; truncated: boolean }>(`${prefix}/git/trees/${commit.sha}?recursive=1`, true);
  if (tree.truncated) reasons.push('GitHub truncated the recursive tree. The displayed inventory is partial; narrow the repository scope or retry a smaller snapshot.');
  const maxFiles = Math.min(Math.max(options.maxFiles ?? MAX_FILES, 1), 10_000);
  const allFiles = tree.tree.filter(item => item.type === 'blob' || item.type === 'commit').sort((a, b) => a.path.localeCompare(b.path));
  const inventory = allFiles.slice(0, maxFiles);
  if (allFiles.length > maxFiles) reasons.push(`Inventory is limited to ${maxFiles.toLocaleString()} of ${allFiles.length.toLocaleString()} files. No complete-repository claim is made.`);
  const nodes = inventory.map(entry => ({ ...nodeForPath(repository.full_name, entry.path), language: languageFor(entry.path), blobSha: entry.sha, fileMode: entry.mode, size: entry.size, importCoverage: isSourceFile(entry.path) ? 'pending' : 'unsupported' }));
  const groups = deriveGroups(nodes.map(node => node.path)); const paths = new Set(nodes.map(node => node.path)); const nodeByPath = new Map(nodes.map(node => [node.path, node]));
  const maxSourceFiles = Math.min(Math.max(options.maxSourceFiles ?? MAX_PARSE_FILES, 0), 500);
  const eligible = inventory.filter(entry => entry.type === 'blob' && entry.mode !== '120000' && isSourceFile(entry.path) && (entry.size ?? 0) <= 80_000);
  const parseEntries = eligible.slice(0, maxSourceFiles);
  if (eligible.length > parseEntries.length) reasons.push(`Import analysis covers ${parseEntries.length} of ${eligible.length} eligible JavaScript/TypeScript files; unparsed files remain visible.`);
  const unsupported = inventory.filter(entry => !isSourceFile(entry.path)).length;
  if (unsupported) reasons.push(`${unsupported} files are inventoried as context; dependency extraction currently supports JavaScript and TypeScript only.`);
  const special = inventory.filter(entry => entry.mode === '120000' || entry.type === 'commit').length;
  if (special) reasons.push(`${special} symlink/submodule entries are represented without following their targets.`);
  const oversized = inventory.filter(entry => isSourceFile(entry.path) && (entry.size ?? 0) > 80_000).length;
  if (oversized) reasons.push(`${oversized} oversized source files exceed the 80KB parse limit.`);
  emit('indexing', 22, `Resolving imports in ${parseEntries.length} source files`);
  const workspacePackages: Record<string, string> = {};
  type ScopedConfig = { path: string; directory: string; aliases: Record<string, string[]>; unsupported: boolean };
  const scopedConfigs: ScopedConfig[] = [];
  // Read declarative configuration only. Extends/plugins/scripts are never executed.
  const allManifests = inventory.filter(entry => /(^|\/)package\.json$/.test(entry.path) || /(^|\/)tsconfig(?:\.[^/]*)?\.json$/.test(entry.path));
  const manifests = allManifests.slice(0, 20);
  if (allManifests.length > manifests.length) reasons.push(`Configuration discovery is limited to ${manifests.length} of ${allManifests.length} manifests; omitted package/alias resolution is unsupported.`);
  const declarations = await mapLimit(manifests, 4, async entry => {
    try {
      const text = await client.source(address, commit.sha, entry.path, 80_000);
      if (entry.path.endsWith('package.json')) {
        const pkg = JSON.parse(text) as { name?: string; source?: string; main?: string; module?: string };
        if (pkg.name) { const base = posix.dirname(entry.path); const entryPath = pkg.source ?? pkg.module ?? pkg.main ?? 'src/index.ts'; return { packageName: pkg.name, packageEntry: posix.normalize(posix.join(base, entryPath)) }; }
      } else {
        const { config, error } = (await import('typescript')).default.parseConfigFileTextToJson(entry.path, text) as { config?: { extends?: unknown; references?: unknown; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }; error?: unknown };
        const opts = config?.compilerOptions;
        const aliases: Record<string, string[]> = {};
        for (const [alias, values] of Object.entries(opts?.paths ?? {})) if (Array.isArray(values)) aliases[alias] = values.filter(value => typeof value === 'string').map(value => posix.normalize(posix.join(posix.dirname(entry.path), opts?.baseUrl ?? '.', value)));
        return { config: { path: entry.path, directory: posix.dirname(entry.path), aliases, unsupported: Boolean(error || config?.extends || config?.references) } };
      }
    } catch { return { failedPath: entry.path }; }
    return undefined;
  });
  // Reduce in tree-path order, never network completion order. Aliases belong to their config directory.
  const ambiguousPackages = new Set<string>();
  for (const declaration of declarations) {
    if (!declaration) continue;
    if ('config' in declaration && declaration.config) scopedConfigs.push(declaration.config);
    else if ('packageName' in declaration && declaration.packageName) {
      if (ambiguousPackages.has(declaration.packageName)) continue;
      if (workspacePackages[declaration.packageName] && workspacePackages[declaration.packageName] !== declaration.packageEntry) { ambiguousPackages.add(declaration.packageName); delete workspacePackages[declaration.packageName]; reasons.push(`Duplicate workspace package name ${declaration.packageName} has ambiguous resolution.`); }
      else workspacePackages[declaration.packageName] = declaration.packageEntry;
    } else if ('failedPath' in declaration) {
      reasons.push(`Configuration ${declaration.failedPath} is unavailable or invalid; its aliases are unsupported.`);
      if (declaration.failedPath && posix.basename(declaration.failedPath).startsWith('tsconfig')) scopedConfigs.push({ path: declaration.failedPath, directory: posix.dirname(declaration.failedPath), aliases: {}, unsupported: true });
    }
  }
  if (scopedConfigs.some(config => config.unsupported)) reasons.push('Configuration inheritance/project references are not evaluated. Files use their nearest tsconfig; alias imports requiring unsupported configuration remain unresolved.');
  const resolverFor = (path: string): ResolverOptions => {
    const candidates = scopedConfigs.filter(config => config.directory === '.' || path.startsWith(`${config.directory}/`)).sort((a, b) => b.directory.length - a.directory.length || Number(posix.basename(b.path) === 'tsconfig.json') - Number(posix.basename(a.path) === 'tsconfig.json') || a.path.localeCompare(b.path));
    const nearest = candidates[0];
    if (!nearest) return { workspacePackages };
    const sameDirectory = candidates.filter(config => config.directory === nearest.directory);
    if (sameDirectory.length > 1 && posix.basename(nearest.path) !== 'tsconfig.json') return { workspacePackages }; // Named configs have no proven include/exclude ownership.
    return { aliases: nearest.unsupported ? {} : nearest.aliases, workspacePackages };
  };
  for (const directory of unique(scopedConfigs.map(config => config.directory))) {
    const configs = scopedConfigs.filter(config => config.directory === directory);
    if (configs.length > 1 && !configs.some(config => posix.basename(config.path) === 'tsconfig.json')) reasons.push(`Multiple named tsconfigs in ${directory} have ambiguous file ownership; their alias imports are left unresolved.`);
  }
  const edges: ImportEdge[] = []; let analyzed = 0; let unresolved = 0; let failed = 0;
  await mapLimit(parseEntries, 6, async (entry, index) => {
    options.signal?.throwIfAborted();
    try {
      const text = await client.source(address, commit.sha, entry.path, 80_000);
      const resolver = resolverFor(entry.path);
      for (const reference of extractImports(text, entry.path)) {
        const target = resolveImport(entry.path, reference.specifier, paths, resolver);
        if (!target) { if (reference.specifier.startsWith('.') || Object.keys(resolver.aliases ?? {}).some(alias => reference.specifier.startsWith(alias.split('*')[0]!))) unresolved++; continue; }
        const sourceNode = nodeByPath.get(entry.path)!; const targetNode = nodeByPath.get(target)!;
        edges.push({ id: `edge:${hash(`${sourceNode.id}:${targetNode.id}:${reference.kind}:${reference.line}`)}`, source: sourceNode.id, target: targetNode.id, kind: reference.kind, evidence: { path: entry.path, line: reference.line, specifier: reference.specifier, snapshotSha: commit.sha, resolver: 'typescript-static-scoped-v2' } });
      }
      nodeByPath.get(entry.path)!.importCoverage = 'complete'; analyzed++;
    } catch (error) { if (options.signal?.aborted) throw error; nodeByPath.get(entry.path)!.importCoverage = 'failed'; failed++; }
    if (index % 8 === 0) emit('indexing', 24 + Math.round((index / Math.max(parseEntries.length, 1)) * 45), `Indexed ${analyzed} source files`);
  });
  if (failed) reasons.push(`${failed} source files could not be downloaded or parsed; their dependency coverage is unavailable.`);
  if (unresolved) reasons.push(`${unresolved} internal import specifiers could not be resolved. Dynamic expressions and external packages are not represented as file edges.`);
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
  const snapshot: GraphSnapshot = { schemaVersion: '1', id: `snapshot:${hash(`${repository.full_name}:${commit.sha}:${ANALYZER_VERSION}`)}`, repository: { owner: repository.owner.login, name: repository.name, fullName: repository.full_name, defaultBranch: repository.default_branch, htmlUrl: repository.html_url }, contextSha: commit.sha, contextRef, nodes, edges: edges.sort((a, b) => a.id.localeCompare(b.id)), groups, sources, coverage: { status: reasons.length ? 'partial' : 'complete', reasons: unique(reasons), filesAnalyzed: analyzed, totalFiles: allFiles.length, importsSupported: 'JavaScript/TypeScript static imports', excludedExternalPackages: true }, createdAt: new Date().toISOString(), mode: 'github', sourcePagination, analyzerVersion: ANALYZER_VERSION, groupingRevision: 'rules-v1', parserLimits: { maxFiles, maxSourceFiles, maxSourceBytes: 80_000 }, defaultSelection: [] };
  emit('ready', 100, `Ready: ${nodes.length} files and ${edges.length} evidenced connections`);
  return validateGraphSnapshot(snapshot);
}

export { loadSourceChanges } from './footprints';
