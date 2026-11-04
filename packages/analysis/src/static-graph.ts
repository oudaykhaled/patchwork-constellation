import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import ts from 'typescript';
import { AstImportFactsSchema, FileModeSchema, IncrementalAnalysisBaselineSchema, type Coverage, type FileNode, type ImportEdge, type IncrementalAnalysisBaseline, type IncrementalAnalysisStats } from '@patchwork/contracts';
import { GitHubClient, type RepositoryAddress } from '@patchwork/github';
import { applyHierarchy, deriveRepositoryHierarchy, nodeForPath, type ManifestBoundary } from './groups';
import { importIsInternal, isSourceFile, languageFor, resolveImport, scanImportsDetailed, scriptKindForPath, PARSER_VERSION, RESOLVER_VERSION, type ImportScan, type ResolverOptions, type WorkspacePackage } from './imports';
import { ANALYZER_VERSION } from './incremental';

export interface TreeEntry { path: string; type: 'blob' | 'tree' | 'commit'; mode: string; sha: string; size?: number; }
/**
 * Read-only access to one pinned snapshot. GitHub and local mirrors both implement it;
 * neither ever executes repository content.
 */
export interface SnapshotReader {
  tree(sha: string): Promise<{ tree: TreeEntry[]; truncated: boolean }>;
  source(sha: string, path: string, maxBytes: number): Promise<string>;
}
/** Server-configured inventory scope. Patterns are matched against repository-relative paths. */
export interface PathFilter { include?: string[]; exclude?: string[]; }
export interface StaticGraphOptions {
  maxFiles?: number; maxSourceFiles?: number; maxManifests?: number; signal?: AbortSignal;
  /** Upper clamp for maxFiles. Defaults to the GitHub-mode ceiling of 10,000. */
  maxFilesCeiling?: number;
  /** Per-blob parse limit in bytes. Defaults to 80,000. */
  maxSourceBytes?: number;
  /** Optional inventory scope; every excluded file is counted in coverage reasons. */
  pathFilter?: PathFilter;
  /** Out-of-repository mapping that replaces an in-repository .constellation.json. */
  mappingOverride?: unknown;
  /** Adds explicit coverage reasons naming the top-level folders an inventory cap removed. */
  explainInventoryCap?: boolean;
  parsePaths?: Set<string>;
  /** Internal authorized snapshot projection only; never accepted from HTTP request input. */
  incrementalBaseline?: unknown;
  onProgress?: (analyzed: number, eligible: number, incremental: Readonly<IncrementalAnalysisStats>) => void;
}
export interface StaticGraphResult {
  nodes: FileNode[]; edges: ImportEdge[]; coverage: Coverage;
  hierarchy: ReturnType<typeof deriveRepositoryHierarchy>;
  parserLimits: { maxFiles: number; maxSourceFiles: number; maxSourceBytes: number; maxManifests: number };
  incremental: IncrementalAnalysisStats;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const unique = (values: string[]) => [...new Set(values)];
const DEFAULT_MAX_SOURCE_BYTES = 80_000;
const GITHUB_MAX_FILES_CEILING = 10_000;
const escapePattern = (value: string) => value.replace(/[.+^$(){}|[\]\\]/g, character => `\\${character}`);
/** Minimal glob: `**` spans folders, `*` stays inside one segment; a bare prefix matches a folder. */
export function pathPattern(pattern: string): RegExp {
  const trimmed = pattern.replace(/^\/+|\/+$/g, '');
  let source = '';
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index]!;
    if (character === '*' && trimmed[index + 1] === '*') {
      index++;
      if (trimmed[index + 1] === '/') { index++; source += '(?:.*/)?'; } else source += '.*';
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += escapePattern(character);
  }
  return new RegExp(`^${source}(?:/|$)`);
}
function isSnapshotReader(value: GitHubClient | SnapshotReader): value is SnapshotReader {
  return typeof (value as Partial<SnapshotReader>).tree === 'function';
}
/** Adapts the existing GitHub gateway without changing any request it makes. */
export function githubSnapshotReader(client: GitHubClient, address: RepositoryAddress): SnapshotReader {
  const prefix = `/repos/${encodeURIComponent(address.owner)}/${encodeURIComponent(address.name)}`;
  return {
    tree: sha => client.get<{ tree: TreeEntry[]; truncated: boolean }>(`${prefix}/git/trees/${sha}?recursive=1`, true),
    source: (sha, path, maxBytes) => client.source(address, sha, path, maxBytes),
  };
}
const pathIsSafe = (path: string) => path.length > 0 && path.length <= 1_024 && !path.startsWith('/') && !/[:\\\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part !== '..' && part !== '.' && part !== '');
const generatedPath = (path: string) => /(^|\/)(node_modules|vendor|dist|build|coverage|generated|__generated__|\.git)(\/|$)/.test(path) || /(?:\.generated|\.g|\.min)\.[cm]?[jt]sx?$/.test(path);
const binaryPath = (path: string) => /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|7z|exe|dll|so|dylib|mp[34]|ogg|wav|sqlite|db)$/i.test(path);
async function mapLimit<T, R>(items: T[], concurrency: number, run: (item: T) => Promise<R>): Promise<R[]> {
  let next = 0; const result: R[] = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await run(items[index]!); }
  }));
  return result;
}

/** Fetches only pinned text blobs and declarative JSON. Never follows links or executes code. */
export async function buildStaticGraph(clientOrReader: GitHubClient | SnapshotReader, address: RepositoryAddress, sha: string, options: StaticGraphOptions = {}): Promise<StaticGraphResult> {
  const reader = isSnapshotReader(clientOrReader) ? clientOrReader : githubSnapshotReader(clientOrReader, address);
  const MAX_SOURCE_BYTES = Math.min(Math.max(Math.floor(options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES), 1_000), 1_048_576);
  const sourceLimitLabel = `${Math.round(MAX_SOURCE_BYTES / 1_000).toLocaleString('en-US')}KB`;
  let baseline: IncrementalAnalysisBaseline | undefined;
  const incremental: IncrementalAnalysisStats = { mode: 'full', baselineStatus: 'missing', reason: 'No reusable authorized baseline was supplied; source blobs are analyzed normally.', eligibleFiles: 0, reusedFiles: 0, parsedFiles: 0, parserCacheHits: 0, fetchedSourceFiles: 0, reusedAtNewPaths: 0, invalidatedFiles: 0 };
  if (options.incrementalBaseline !== undefined) {
    const parsed = IncrementalAnalysisBaselineSchema.safeParse(options.incrementalBaseline);
    if (!parsed.success) { incremental.baselineStatus = 'invalid'; incremental.reason = 'The incremental baseline failed bounded metadata validation; a full analysis was used.'; }
    else if (parsed.data.repository.toLowerCase() !== address.fullName.toLowerCase() || parsed.data.analyzerVersion !== ANALYZER_VERSION || parsed.data.parserVersion !== PARSER_VERSION) {
      incremental.baselineStatus = 'incompatible'; incremental.reason = 'The incremental baseline repository or analyzer/parser version is incompatible; a full analysis was used.';
    } else {
      baseline = parsed.data; incremental.mode = 'incremental'; incremental.baselineStatus = 'accepted'; incremental.basisSha = baseline.contextSha; delete incremental.reason;
    }
  }
  const baselineByPath = new Map(baseline?.files.map(file => [file.path, file]) ?? []);
  const baselineByBlob = new Map(baseline?.files.map(file => [`${file.blobSha}:${file.parseFacts.scriptKind}`, file]) ?? []);
  const tree = await reader.tree(sha);
  const reasons: string[] = [];
  if (tree.truncated) reasons.push('GitHub truncated the recursive tree. The displayed inventory is partial; narrow the repository scope or retry a smaller snapshot.');
  const allEntries = tree.tree.filter(entry => entry.type === 'blob' || entry.type === 'commit');
  const unsafe = allEntries.filter(entry => !pathIsSafe(entry.path));
  if (unsafe.length) reasons.push(`${unsafe.length} invalid repository paths were excluded from inventory.`);
  let allFiles = allEntries.filter(entry => pathIsSafe(entry.path)).sort((a, b) => a.path.localeCompare(b.path));
  if (options.pathFilter && (options.pathFilter.include?.length || options.pathFilter.exclude?.length)) {
    const include = (options.pathFilter.include ?? []).map(pattern => ({ pattern, test: pathPattern(pattern) }));
    const exclude = (options.pathFilter.exclude ?? []).map(pattern => ({ pattern, test: pathPattern(pattern), count: 0 }));
    let notIncluded = 0;
    allFiles = allFiles.filter(entry => {
      if (include.length && !include.some(rule => rule.test.test(entry.path))) { notIncluded++; return false; }
      const rule = exclude.find(item => item.test.test(entry.path));
      if (rule) { rule.count++; return false; }
      return true;
    });
    if (notIncluded) reasons.push(`Configured scope keeps only ${include.map(rule => rule.pattern).join(', ')}; ${notIncluded.toLocaleString('en-US')} files outside it are not inventoried.`);
    for (const rule of exclude) if (rule.count) reasons.push(`Configured scope excludes ${rule.pattern}: ${rule.count.toLocaleString('en-US')} files are not inventoried.`);
  }
  const maxFilesCeiling = Math.min(Math.max(Math.floor(options.maxFilesCeiling ?? GITHUB_MAX_FILES_CEILING), 1), 25_000);
  const maxFiles = Math.min(Math.max(options.maxFiles ?? 2_000, 1), maxFilesCeiling);
  const maxSourceFiles = Math.min(Math.max(options.maxSourceFiles ?? 120, 0), 500);
  const maxManifests = Math.min(Math.max(options.maxManifests ?? 20, 0), 50);
  const inventory = allFiles.slice(0, maxFiles);
  if (allFiles.length > inventory.length) reasons.push(`Inventory is limited to ${maxFiles.toLocaleString()} of ${allFiles.length.toLocaleString()} files. No complete-repository claim is made.`);
  if (options.explainInventoryCap && allFiles.length > inventory.length) {
    // The cap is an alphabetical cut. Name what it removed so nothing disappears silently.
    const topFolder = (path: string) => path.includes('/') ? path.split('/')[0]! : '(root files)';
    const kept = new Set(inventory.map(entry => topFolder(entry.path)));
    const dropped = new Map<string, number>();
    for (const entry of allFiles.slice(maxFiles)) { const top = topFolder(entry.path); dropped.set(top, (dropped.get(top) ?? 0) + 1); }
    const fully = [...dropped].filter(([top]) => !kept.has(top));
    const partly = [...dropped].filter(([top]) => kept.has(top));
    const list = (items: [string, number][]) => items.slice(0, 40).map(([top, count]) => `${top} (${count.toLocaleString('en-US')})`).join(', ') + (items.length > 40 ? `, and ${items.length - 40} more` : '');
    reasons.push(`The inventory cap is an alphabetical cut after ${inventory.at(-1)?.path ?? 'no files'}: ${(allFiles.length - inventory.length).toLocaleString('en-US')} files are missing.${fully.length ? ` Folders missing entirely: ${list(fully)}.` : ''}${partly.length ? ` Folders cut part-way: ${list(partly)}.` : ''} Raise maxFiles or narrow the configured scope.`);
  }
  let nodes: FileNode[] = inventory.map(entry => {
    let fileKind: FileNode['fileKind'] = 'file', importCoverage: FileNode['importCoverage'] = 'partial'; const importReasons: string[] = [];
    if (entry.type === 'commit') { fileKind = 'submodule'; importCoverage = 'excluded'; importReasons.push('Git submodule is represented but its repository is not followed.'); }
    else if (entry.mode === '120000') { fileKind = 'symlink'; importCoverage = 'excluded'; importReasons.push('Symbolic-link target is not followed.'); }
    else if (generatedPath(entry.path)) { fileKind = 'generated'; importCoverage = 'excluded'; importReasons.push('Generated/vendor/build content is inventoried but excluded from dependency extraction.'); }
    else if (binaryPath(entry.path)) { fileKind = 'binary'; importCoverage = 'unsupported'; importReasons.push('Binary asset has no JavaScript/TypeScript import extraction.'); }
    else if (!isSourceFile(entry.path)) { importCoverage = 'unsupported'; importReasons.push('Dependency extraction supports JavaScript and TypeScript only.'); }
    else if ((entry.size ?? 0) > MAX_SOURCE_BYTES) { importCoverage = 'excluded'; importReasons.push(`Source exceeds the ${sourceLimitLabel} parse limit.`); }
    else importReasons.push('Dependency extraction has not yet run for this source blob.');
    return { ...nodeForPath(address.fullName, entry.path), language: languageFor(entry.path), blobSha: entry.sha, fileMode: FileModeSchema.parse(entry.mode), size: entry.size, fileKind, importCoverage, importReasons };
  });
  const paths = new Set(nodes.map(node => node.path));
  const nodeByPath = new Map(nodes.map(node => [node.path, node]));
  const eligible = inventory.filter(entry => nodeByPath.get(entry.path)?.importCoverage === 'partial' && (!options.parsePaths || options.parsePaths.has(entry.path)));
  const parseEntries = eligible.slice(0, maxSourceFiles);
  incremental.eligibleFiles = parseEntries.length;
  const parseSet = new Set(parseEntries.map(entry => entry.path));
  for (const node of nodes) if (node.importCoverage === 'partial' && !parseSet.has(node.path)) {
    node.importCoverage = 'partial'; node.importReasons = [options.parsePaths && !options.parsePaths.has(node.path) ? 'Selected-head analysis is scoped to directly changed files.' : 'Source was not parsed because the configured file budget was reached.'];
  }
  if (eligible.length > parseEntries.length) reasons.push(`Import analysis covers ${parseEntries.length} of ${eligible.length} eligible JavaScript/TypeScript files; unparsed files remain visible.`);
  const unsupported = nodes.filter(node => node.importCoverage === 'unsupported').length;
  const excluded = nodes.filter(node => node.importCoverage === 'excluded').length;
  if (unsupported) reasons.push(`${unsupported} files are inventoried as context with unsupported dependency extraction.`);
  if (excluded) reasons.push(`${excluded} symlink/submodule, generated/vendor, or oversized entries are represented under the explicit exclusion policy; targets are not followed.`);

  const workspacePackages: Record<string, WorkspacePackage> = {};
  type ScopedConfig = { path: string; directory: string; aliases: Record<string, string[]>; unsupported: boolean };
  const scopedConfigs: ScopedConfig[] = [];
  const manifestBoundaries: ManifestBoundary[] = [];
  const candidates = inventory.filter(entry => entry.type === 'blob' && entry.mode !== '120000' && (entry.size ?? 0) <= MAX_SOURCE_BYTES && !generatedPath(entry.path) && (/(^|\/)package\.json$/.test(entry.path) || /(^|\/)tsconfig(?:\.[^/]*)?\.json$/.test(entry.path)));
  const manifests = candidates.slice(0, maxManifests);
  if (candidates.length > manifests.length) reasons.push(`Configuration discovery is limited to ${manifests.length} of ${candidates.length} manifests; omitted package/alias resolution is unsupported.`);
  const declarations = await mapLimit(manifests, 4, async entry => {
    try {
      const text = await reader.source(sha, entry.path, MAX_SOURCE_BYTES);
      if (entry.path.endsWith('package.json')) {
        const pkg = JSON.parse(text) as { name?: unknown; source?: unknown; main?: unknown; module?: unknown; exports?: unknown };
        const directory = posix.dirname(entry.path);
        const entryPath = [pkg.source, pkg.module, pkg.main].find(value => typeof value === 'string') as string | undefined;
        return { manifest: { path: entry.path, ...(typeof pkg.name === 'string' ? { name: pkg.name } : {}) }, ...(typeof pkg.name === 'string' ? { packageName: pkg.name, packageValue: { directory, entry: posix.normalize(posix.join(directory, entryPath ?? 'src/index.ts')), ...(pkg.exports !== undefined ? { exports: pkg.exports } : {}) } satisfies WorkspacePackage } : {}) };
      }
      const { config, error } = ts.parseConfigFileTextToJson(entry.path, text) as { config?: { extends?: unknown; references?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } }; error?: unknown };
      const opts = config?.compilerOptions; const aliases: Record<string, string[]> = {};
      if (opts?.paths && typeof opts.paths === 'object' && !Array.isArray(opts.paths)) for (const [alias, values] of Object.entries(opts.paths)) if (Array.isArray(values)) aliases[alias] = values.filter((value): value is string => typeof value === 'string').map(value => posix.normalize(posix.join(posix.dirname(entry.path), typeof opts.baseUrl === 'string' ? opts.baseUrl : '.', value)));
      return { config: { path: entry.path, directory: posix.dirname(entry.path), aliases, unsupported: Boolean(error || config?.extends || config?.references) } };
    } catch { return { failedPath: entry.path }; }
  });
  const ambiguousPackages = new Set<string>();
  for (const declaration of declarations) {
    if ('manifest' in declaration && declaration.manifest) manifestBoundaries.push(declaration.manifest);
    if ('config' in declaration && declaration.config) scopedConfigs.push(declaration.config);
    else if ('packageName' in declaration && declaration.packageName && declaration.packageValue) {
      if (ambiguousPackages.has(declaration.packageName)) continue;
      if (workspacePackages[declaration.packageName]) { ambiguousPackages.add(declaration.packageName); delete workspacePackages[declaration.packageName]; reasons.push(`Duplicate workspace package name ${declaration.packageName} has ambiguous resolution.`); }
      else workspacePackages[declaration.packageName] = declaration.packageValue;
    } else if ('failedPath' in declaration) {
      reasons.push(`Configuration ${declaration.failedPath} is unavailable or invalid; its aliases are unsupported.`);
      if (declaration.failedPath && posix.basename(declaration.failedPath).startsWith('tsconfig')) scopedConfigs.push({ path: declaration.failedPath, directory: posix.dirname(declaration.failedPath), aliases: {}, unsupported: true });
    }
  }
  if (scopedConfigs.some(config => config.unsupported)) reasons.push('Configuration inheritance/project references are not evaluated. Files use their nearest tsconfig; imports requiring unsupported configuration remain unresolved.');
  const resolverFor = (path: string): ResolverOptions => {
    const matches = scopedConfigs.filter(config => config.directory === '.' || path.startsWith(`${config.directory}/`)).sort((a, b) => b.directory.length - a.directory.length || Number(posix.basename(b.path) === 'tsconfig.json') - Number(posix.basename(a.path) === 'tsconfig.json') || a.path.localeCompare(b.path));
    const nearest = matches[0];
    if (!nearest) return { workspacePackages };
    if (matches.filter(config => config.directory === nearest.directory).length > 1 && posix.basename(nearest.path) !== 'tsconfig.json') return { workspacePackages, coverageReasons: ['Multiple named tsconfig files have ambiguous ownership; aliases are not inferred.'] };
    return { aliases: nearest.unsupported ? {} : nearest.aliases, workspacePackages, ...(nearest.unsupported ? { coverageReasons: ['The nearest tsconfig requires unsupported inheritance/project references or is invalid; alias resolution is partial.'] } : {}) };
  };
  for (const directory of unique(scopedConfigs.map(config => config.directory))) {
    const configs = scopedConfigs.filter(config => config.directory === directory);
    if (configs.length > 1 && !configs.some(config => posix.basename(config.path) === 'tsconfig.json')) reasons.push(`Multiple named tsconfigs in ${directory} have ambiguous file ownership; their aliases remain unresolved.`);
  }
  let mapping: unknown;
  const mappingEntry = options.mappingOverride !== undefined ? undefined : inventory.find(entry => entry.path === '.constellation.json');
  if (options.mappingOverride !== undefined) mapping = options.mappingOverride;
  else if (mappingEntry) {
    if (mappingEntry.type !== 'blob' || mappingEntry.mode === '120000' || (mappingEntry.size ?? 0) > MAX_SOURCE_BYTES) reasons.push('Repository mapping .constellation.json is not a regular bounded text file; deterministic hierarchy is retained.');
    else try { mapping = JSON.parse(await reader.source(sha, mappingEntry.path, MAX_SOURCE_BYTES)); } catch { reasons.push('Repository mapping .constellation.json is invalid or unavailable; deterministic hierarchy is retained.'); }
  }
  let hierarchy;
  try { hierarchy = deriveRepositoryHierarchy(nodes.map(node => node.path), { manifests: manifestBoundaries, mapping }); }
  catch { reasons.push(options.mappingOverride !== undefined ? 'The configured island mapping failed validation; deterministic hierarchy is retained.' : 'Repository mapping .constellation.json failed validation; deterministic hierarchy is retained.'); hierarchy = deriveRepositoryHierarchy(nodes.map(node => node.path), { manifests: manifestBoundaries }); }
  reasons.push(...hierarchy.warnings);
  // Preserve references held by nodeByPath while assigning presentation hierarchy.
  const grouped = applyHierarchy(nodes, hierarchy);
  nodes.forEach((node, index) => Object.assign(node, grouped[index]));
  const edges: ImportEdge[] = []; let analyzed = 0; let partial = 0; let failed = 0;
  await mapLimit(parseEntries, 6, async entry => {
    options.signal?.throwIfAborted(); const node = nodeByPath.get(entry.path)!;
    try {
      const previous = baselineByPath.get(entry.path);
      const candidate = previous?.blobSha === entry.sha && previous.parseFacts.scriptKind === scriptKindForPath(entry.path) ? previous : baselineByBlob.get(`${entry.sha}:${scriptKindForPath(entry.path)}`);
      let scan: ImportScan;
      if (candidate) {
        scan = structuredClone(candidate.parseFacts); incremental.reusedFiles++;
        if (candidate.path !== entry.path) incremental.reusedAtNewPaths++;
        node.parseFacts = structuredClone(candidate.parseFacts); node.parserVersion = PARSER_VERSION;
      } else {
        if (previous) incremental.invalidatedFiles++;
        incremental.fetchedSourceFiles++;
        const text = await reader.source(sha, entry.path, MAX_SOURCE_BYTES);
        if (text.startsWith('version https://git-lfs.github.com/spec/v1\n') || text.startsWith('version https://git-lfs.github.com/spec/v1\r\n')) { node.fileKind = 'lfs-pointer'; node.importCoverage = 'excluded'; node.importReasons = ['Git LFS pointer is inventoried without downloading its target.']; return; }
        if (text.includes('\0')) { node.fileKind = 'binary'; node.importCoverage = 'unsupported'; node.importReasons = ['Binary source blob is not parsed.']; return; }
        const scanned = scanImportsDetailed(text, entry.path, entry.sha); scan = scanned.facts;
        if (scanned.parsed) incremental.parsedFiles++; else incremental.parserCacheHits++;
        const stored = AstImportFactsSchema.safeParse({ schemaVersion: '1', scriptKind: scriptKindForPath(entry.path), references: scan.references, reasons: scan.reasons });
        if (stored.success) { node.parseFacts = stored.data; node.parserVersion = PARSER_VERSION; }
      }
      // Syntax facts are reusable. Resolved edges/configuration decisions never are.
      const resolver = resolverFor(entry.path);
      const fileReasons = [...(resolver.coverageReasons ?? []), ...scan.reasons]; const externalImports: FileNode['externalImports'] = []; const unresolvedImports: FileNode['unresolvedImports'] = [];
      for (const reference of scan.references) {
        const target = resolveImport(entry.path, reference.specifier, paths, { ...resolver, resolutionMode: reference.resolutionMode });
        if (!target) {
          const internal = importIsInternal(reference.specifier, resolver);
          const reason = internal ? 'No matching inventoried file under the static resolver/configuration policy.' : 'External package or unsupported bare specifier; represented as metadata, not a file node.';
          (internal ? unresolvedImports : externalImports).push({ ...reference, reason });
          if (internal) fileReasons.push(`Unresolved import ${reference.specifier} at line ${reference.line}: ${reason}`);
          continue;
        }
        const targetNode = nodeByPath.get(target)!;
        if (targetNode.fileKind === 'symlink' || targetNode.fileKind === 'submodule') { fileReasons.push(`Import ${reference.specifier} targets a ${targetNode.fileKind}; its target is not followed.`); continue; }
        edges.push({ id: `edge:${hash(`${sha}:${node.id}:${targetNode.id}:${reference.kind}:${reference.line}`)}`, source: node.id, target: targetNode.id, kind: reference.kind, provenance: 'context', evidence: { path: entry.path, line: reference.line, specifier: reference.specifier, snapshotSha: sha, resolver: RESOLVER_VERSION } });
      }
      node.importCoverage = fileReasons.length ? 'partial' : 'complete'; node.importReasons = unique(fileReasons); node.externalImports = externalImports; node.unresolvedImports = unresolvedImports;
      if (fileReasons.length) partial++; analyzed++;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      node.importCoverage = 'failed'; node.importReasons = ['Source could not be downloaded or parsed at this immutable SHA.']; failed++;
    }
    options.onProgress?.(analyzed, parseEntries.length, incremental);
  });
  if (failed) reasons.push(`${failed} source files could not be downloaded or parsed; their dependency coverage is unavailable.`);
  if (partial) reasons.push(`${partial} parsed source files have unresolved imports, non-literal imports, or syntax errors. Per-file reasons are attached to nodes.`);
  const newlyExcluded = nodes.filter(node => node.fileKind === 'lfs-pointer' || node.fileKind === 'binary' && isSourceFile(node.path)).length;
  if (newlyExcluded) reasons.push(`${newlyExcluded} LFS pointers or binary source blobs were not parsed or followed.`);
  return { nodes, edges: edges.sort((a, b) => a.id.localeCompare(b.id)), hierarchy, coverage: { status: reasons.length ? 'partial' : 'complete', reasons: unique(reasons), filesAnalyzed: analyzed, totalFiles: allEntries.length, importsSupported: 'JavaScript/TypeScript static imports', excludedExternalPackages: true }, parserLimits: { maxFiles, maxSourceFiles, maxSourceBytes: MAX_SOURCE_BYTES, maxManifests }, incremental };
}
