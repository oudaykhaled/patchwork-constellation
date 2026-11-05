/**
 * Offline source for server-registered local Git mirrors.
 *
 * Every read goes through runLocalGit: a fixed allowlist of read-only plumbing commands,
 * run with shell:false, a scrubbed environment and no transport enabled. No command
 * receives a remote address, and nothing in this module opens a socket. Repository
 * content is only read as data and is never executed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateGraphSnapshot, type ChangeSource, type ChangeStatus, type FileNode, type GraphSnapshot } from '@patchwork/contracts';
import type { AnalysisProgress, AnalyzeInput } from './index';
import { deriveGroups } from './groups';
import { ANALYZER_VERSION } from './incremental';
import { buildStaticGraph, type SnapshotReader, type TreeEntry } from './static-graph';
import { GitHubError } from '@patchwork/github';
import { EMPTY_GIT_TREE, GIT_RENAME_LIMIT, LOCAL_SAFE_GIT_CONFIG, localSafeEnvironment, parseGitDiff, type GitDiffFile } from './git-fallback';
import { trackGitProcess } from './git-processes';
import { mergeChangesByIdentity, toChanges, type ApiFile, type ChangeLineage } from './footprints';
import { enrichSelectedSourceDependencies } from './source-dependencies';
import type { FootprintRecord, LocalRepository } from './local-git-config';

export const LOCAL_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(['rev-parse', 'for-each-ref', 'ls-tree', 'cat-file', 'log', 'rev-list', 'diff-tree', 'merge-base']);
// Options that could write files, run programs, change repository selection or name a
// transport. Our own call sites never build them; this is defense in depth.
const FORBIDDEN_ARGUMENT = /^(?:--output|--ext-diff|--textconv|--exec|--upload-pack|--receive-pack|--git-dir|--work-tree|--namespace|--config|-c$|-C$)|^[A-Za-z][A-Za-z0-9+.-]*:\/\/|^ext::|^[^/:\s]+@[^/:\s]+:/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
/** Branches, tags and commits. No option-looking names, ranges, reflog or path syntax. */
export const LOCAL_REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/@~^-]{1,200}$/;
const PAGE_SIZE = 30;
const MAX_SELECTION = 20;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const unique = <T>(values: T[]) => [...new Set(values)];
const count = (value: number) => value.toLocaleString('en-US');

export class LocalGitError extends Error {
  constructor(message: string, public status = 502, public code = 'LOCAL_GIT_FAILED') { super(message); this.name = 'LocalGitError'; }
}
export interface LocalGitRunOptions {
  signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number;
  /** Called when Git says it skipped rename detection. Git's own text is never surfaced. */
  onRenameLimit?: () => void;
}
const RENAME_LIMIT_WARNING = /rename detection was skipped|found copies from modified paths due to too many files/;

/** The only process entry point for local mode. */
export function runLocalGit(gitDir: string, args: string[], options: LocalGitRunOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!args[0] || !LOCAL_GIT_SUBCOMMANDS.has(args[0])) return reject(new LocalGitError('This Git command is not permitted for local repositories.', 500, 'LOCAL_GIT_DENIED'));
    if (args.some(arg => typeof arg !== 'string' || arg.includes('\0') || FORBIDDEN_ARGUMENT.test(arg))) return reject(new LocalGitError('This Git argument is not permitted for local repositories.', 500, 'LOCAL_GIT_DENIED'));
    if (options.signal?.aborted) return reject(new LocalGitError('The local read was cancelled.', 499, 'ABORTED'));
    const limit = options.maxOutputBytes ?? 64 * 1_048_576;
    const child = spawn('git', [`--git-dir=${gitDir}`, '--no-replace-objects', '--literal-pathspecs', ...LOCAL_SAFE_GIT_CONFIG, ...args], { cwd: gitDir, env: localSafeEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    trackGitProcess(child);
    const output: Buffer[] = []; let bytes = 0; let failure: LocalGitError | undefined; let diagnostics = '';
    const stop = (error: LocalGitError) => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(new LocalGitError('The local read was cancelled.', 499, 'ABORTED'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new LocalGitError('A local Git read exceeded its time budget.', 504, 'LOCAL_GIT_LIMIT')), options.timeoutMs ?? 60_000);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) stop(new LocalGitError('A local Git read exceeded its output budget.', 413, 'LOCAL_GIT_LIMIT')); else output.push(chunk); });
    // Never surface Git diagnostics: they can contain paths. Only a fixed warning is matched.
    child.stderr.on('data', (chunk: Buffer) => { if (options.onRenameLimit) diagnostics = (diagnostics + chunk.toString('latin1')).slice(-4_096); });
    child.on('error', () => { failure ??= new LocalGitError('Git is not available on this host.', 502, 'LOCAL_GIT_FAILED'); });
    child.on('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new LocalGitError('The local mirror could not be read at the requested revision.', 502, 'LOCAL_GIT_FAILED'));
      else { if (RENAME_LIMIT_WARNING.test(diagnostics)) options.onRenameLimit?.(); resolve(Buffer.concat(output)); }
    });
  });
}
const tryGit = (repository: LocalRepository, args: string[], options: LocalGitRunOptions = {}) => runLocalGit(repository.gitDir, args, options).catch(error => {
  if (error instanceof LocalGitError && error.code === 'LOCAL_GIT_FAILED') return undefined;
  throw error;
});

/** Pins a branch, tag or commit in the mirror to its full commit SHA. */
export async function resolveLocalCommit(repository: LocalRepository, ref: string, signal?: AbortSignal): Promise<string> {
  if (!LOCAL_REF_PATTERN.test(ref)) throw new LocalGitError('Enter a branch, tag or commit that exists in the local mirror.', 400, 'LOCAL_REF');
  const output = await tryGit(repository, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { signal, maxOutputBytes: 256 });
  const sha = output?.toString('utf8').trim().toLowerCase();
  if (!sha || !SHA.test(sha)) throw new LocalGitError('That branch or commit is not in the local mirror.', 404, 'LOCAL_REF');
  return sha;
}

/** Pinned tree and blob access backed by ls-tree/cat-file. */
export class LocalSnapshotReader implements SnapshotReader {
  private blobs = new Map<string, Map<string, string>>();
  /** Entries whose names are not valid UTF-8; they are left out of the inventory and counted. */
  invalidPaths = 0;
  constructor(private repository: LocalRepository, private signal?: AbortSignal) {}
  async tree(sha: string): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
    if (!SHA.test(sha)) throw new LocalGitError('Local trees are read at pinned commits only.', 400, 'INVALID_REF');
    const output = await runLocalGit(this.repository.gitDir, ['ls-tree', '-r', '-l', '-z', '--full-tree', sha], { signal: this.signal, maxOutputBytes: 256 * 1_048_576, timeoutMs: 120_000 });
    const decoder = new TextDecoder('utf8', { fatal: true }); const entries: TreeEntry[] = []; const blobs = new Map<string, string>();
    let start = 0; this.invalidPaths = 0;
    for (let index = output.indexOf(0, start); index !== -1; start = index + 1, index = output.indexOf(0, start)) {
      const record = output.subarray(start, index); const tab = record.indexOf(9);
      const match = tab > 0 ? /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40,64}) +(-|\d+)$/.exec(record.subarray(0, tab).toString('latin1')) : null;
      let path: string;
      try { path = decoder.decode(record.subarray(tab + 1)); } catch { this.invalidPaths++; continue; }
      if (!match) { this.invalidPaths++; continue; }
      const [, mode, type, object, size] = match;
      entries.push({ path, type: type as TreeEntry['type'], mode: mode!, sha: object!, ...(size !== '-' ? { size: Number(size) } : {}) });
      if (type === 'blob') blobs.set(path, object!);
    }
    this.blobs.set(sha, blobs);
    return { tree: entries, truncated: false };
  }
  async source(sha: string, path: string, maxBytes: number): Promise<string> {
    if (!SHA.test(sha) || !path || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === '') || /[\x00-\x1f\x7f]/.test(path)) throw new LocalGitError('Invalid local source request.', 400, 'INVALID_SOURCE_PATH');
    const blob = this.blobs.get(sha)?.get(path);
    const output = await runLocalGit(this.repository.gitDir, ['cat-file', 'blob', blob ?? `${sha}:${path}`], { signal: this.signal, maxOutputBytes: maxBytes, timeoutMs: 30_000 });
    return new TextDecoder().decode(output);
  }
}

interface LocalCommit { sha: string; parents: string[]; date?: string; subject: string; }
function parseLog(output: Buffer): LocalCommit[] {
  return output.toString('utf8').split('\0').map(record => record.replace(/^\n+/, '')).filter(Boolean).flatMap(record => {
    const [sha = '', parents = '', date = '', subject = ''] = record.split('\x1f');
    return SHA.test(sha) ? [{ sha: sha.toLowerCase(), parents: parents.split(' ').filter(value => SHA.test(value)), ...(date ? { date } : {}), subject: subject.trim() }] : [];
  });
}
const LOG_FORMAT = '--format=%H%x1f%P%x1f%cI%x1f%s';
async function readCommit(repository: LocalRepository, sha: string, signal?: AbortSignal): Promise<LocalCommit | undefined> {
  if (!SHA.test(sha)) return undefined;
  const output = await tryGit(repository, ['log', '--no-walk', '--no-show-signature', '--no-color', '-z', LOG_FORMAT, sha], { signal, maxOutputBytes: 1_048_576 });
  return output ? parseLog(output)[0] : undefined;
}
/** Commits per Git call; keeps the argument list far below any platform limit. */
const COMMIT_BATCH = 500;
/**
 * Reads many commits with one Git process per batch. Missing objects, trees and blobs are
 * skipped (--ignore-missing), so the result holds exactly the SHAs that name commits in the
 * mirror. A batch Git cannot read at all falls back to one read per SHA.
 */
async function readCommits(repository: LocalRepository, shas: (string | undefined)[], signal?: AbortSignal): Promise<Map<string, LocalCommit>> {
  const wanted = unique(shas.filter((sha): sha is string => typeof sha === 'string' && SHA.test(sha)).map(sha => sha.toLowerCase()));
  const found = new Map<string, LocalCommit>();
  for (let start = 0; start < wanted.length; start += COMMIT_BATCH) {
    const batch = wanted.slice(start, start + COMMIT_BATCH);
    const output = await tryGit(repository, ['log', '--no-walk=unsorted', '--ignore-missing', '--no-show-signature', '--no-color', '-z', LOG_FORMAT, ...batch], { signal, maxOutputBytes: 16 * 1_048_576 });
    if (output) { for (const commit of parseLog(output)) found.set(commit.sha, commit); continue; }
    for (const sha of batch) { const commit = await readCommit(repository, sha, signal); if (commit?.sha === sha) found.set(sha, commit); }
  }
  return found;
}

const repositoryRef = (repository: LocalRepository, suffix = '') => `local-git://${repository.fullName}${suffix}`;
function commitSource(repository: LocalRepository, commit: LocalCommit, extra: Partial<ChangeSource> = {}): ChangeSource {
  return { id: `commit:${commit.sha}`, kind: 'commit', title: commit.subject || commit.sha, label: commit.sha.slice(0, 7), sha: commit.sha, headSha: commit.sha, baseSha: commit.parents[0] ?? EMPTY_GIT_TREE, comparisonKind: commit.parents.length ? 'first-parent' : 'empty-tree', url: repositoryRef(repository, `/commit/${commit.sha}`), files: [], loaded: false, mergeCommit: commit.parents.length > 1, ...(commit.date ? { sourceUpdatedAt: commit.date } : {}), ...extra };
}
function recordReasons(record: FootprintRecord, repository: LocalRepository): string[] {
  const missing = record.files?.filter(file => file.inHead === false).length ?? 0;
  const noted = record.files?.filter(file => file.note).length ?? 0;
  return [
    `Recorded footprint (${record.origin}). The file list comes from the footprint file, not from a Git comparison in ${repository.fullName}; line counts are not recorded.`,
    ...(missing ? [`${count(missing)} recorded paths are not in the head the footprint was built against; they appear outside the inventory.`] : []),
    ...(noted ? [`${count(noted)} recorded paths carry a note from the footprint file.`] : []),
    ...record.notes.map(note => `Footprint note: ${note}.`),
  ];
}
function recordedSource(repository: LocalRepository, record: FootprintRecord): ChangeSource {
  const pr = record.kind === 'pr';
  const reasons = record.files ? recordReasons(record, repository) : [`${pr ? `Pull request ${record.number}` : `Commit ${record.sha?.slice(0, 12)}`} has no recorded file list and its commits are not in the local mirror, so its footprint cannot be loaded.`];
  return {
    id: record.key, kind: record.kind, title: record.title, label: pr ? `#${record.number}` : record.sha!.slice(0, 7),
    ...(pr ? { number: record.number } : { sha: record.sha }), ...(record.headSha ? { headSha: record.headSha } : record.sha ? { headSha: record.sha } : {}), ...(record.baseSha ? { baseSha: record.baseSha } : {}),
    comparisonKind: 'recorded', recordedOrigin: record.origin, url: repositoryRef(repository, pr ? `/pull/${record.number}` : `/commit/${record.sha}`),
    files: [], loaded: false, coverage: { status: record.files ? 'partial' : 'failed', reasons }, footprintViews: record.views,
    ...(record.state ? { state: record.state } : {}), ...(record.updatedAt ? { sourceUpdatedAt: record.updatedAt } : {}),
  };
}

/**
 * Footprint records become sources by one rule: an exact Git delta when the record's
 * commits are in the mirror, the recorded file list otherwise, and an unloaded entry
 * with an explicit reason when neither exists.
 */
async function footprintSources(repository: LocalRepository, signal?: AbortSignal, kind?: 'pr' | 'commit'): Promise<ChangeSource[]> {
  const sources: ChangeSource[] = [];
  const records = (repository.footprints?.records ?? []).filter(record => !kind || record.kind === kind);
  // One Git process answers every record (per batch), instead of one or two per record.
  const commits = await readCommits(repository, records.flatMap(record => record.kind === 'commit' ? [record.sha] : [record.baseSha, record.headSha]), signal);
  for (const record of records) {
    signal?.throwIfAborted();
    const extra = { footprintViews: record.views, footprintOrigin: record.origin };
    if (record.kind === 'commit' && record.sha) {
      const commit = commits.get(record.sha);
      if (commit) { sources.push(commitSource(repository, commit, { ...extra, ...(record.title !== record.key ? { title: record.title } : {}) })); continue; }
    }
    if (record.kind === 'pr' && record.baseSha && record.headSha && commits.has(record.baseSha) && commits.has(record.headSha)) {
      sources.push({ id: record.key, kind: 'pr', number: record.number, title: record.title, label: `#${record.number}`, url: repositoryRef(repository, `/pull/${record.number}`), baseSha: record.baseSha, baseRefSha: record.baseSha, headSha: record.headSha, comparisonKind: 'merge-base', files: [], loaded: false, ...(record.state ? { state: record.state } : {}), ...(record.updatedAt ? { sourceUpdatedAt: record.updatedAt } : {}), ...extra });
      continue;
    }
    sources.push(recordedSource(repository, record));
  }
  const time = (source: ChangeSource) => Date.parse(String(source.sourceUpdatedAt ?? '')) || 0;
  return sources.sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));
}
async function gitCommitPage(repository: LocalRepository, contextSha: string, page: number, signal?: AbortSignal) {
  const output = await runLocalGit(repository.gitDir, ['log', '--first-parent', '--no-show-signature', '--no-color', '-z', LOG_FORMAT, `--skip=${(page - 1) * PAGE_SIZE}`, '-n', String(PAGE_SIZE + 1), contextSha], { signal, maxOutputBytes: 8 * 1_048_576 });
  const commits = parseLog(output);
  return { commits: commits.slice(0, PAGE_SIZE), nextPage: commits.length > PAGE_SIZE ? page + 1 : null };
}

/** Bounded source listing. PR footprints are listed whole; first-parent commits are paged. */
export async function listLocalRepositorySources(repository: LocalRepository, kind: 'pr' | 'commit', page = 1, contextSha?: string, options: { signal?: AbortSignal } = {}): Promise<{ sources: ChangeSource[]; nextPage: number | null }> {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new LocalGitError('The requested page is invalid.', 400, 'INVALID_PAGINATION');
  const recorded = page === 1 ? await footprintSources(repository, options.signal, kind) : [];
  if (kind === 'pr') return { sources: recorded, nextPage: null };
  const context = contextSha && SHA.test(contextSha) ? contextSha : await resolveLocalCommit(repository, repository.defaultRef, options.signal);
  const { commits, nextPage } = await gitCommitPage(repository, context, page, options.signal);
  const ids = new Set(recorded.map(source => source.id));
  return { sources: [...commits.map(commit => commitSource(repository, commit)).filter(source => !ids.has(source.id)), ...recorded], nextPage };
}

/**
 * Resolve the context once on the server; the durable job input carries only the SHA and the
 * registry fingerprint. The fingerprint marks the job as local and changes whenever the
 * configured scope, mapping, footprints or limits change, so a stored job is never reused
 * for a different configuration.
 */
export async function pinLocalAnalysisInput(input: AnalyzeInput, repository: LocalRepository, signal?: AbortSignal): Promise<AnalyzeInput & { displayContextRef: string; localFingerprint: string }> {
  const displayContextRef = input.contextRef?.trim() || repository.defaultRef;
  const sha = await resolveLocalCommit(repository, displayContextRef, signal);
  return { repository: repository.fullName, mode: input.mode, contextRef: sha, displayContextRef, localFingerprint: repository.fingerprint };
}

export interface LocalAnalysisOptions { signal?: AbortSignal; onProgress?: (progress: AnalysisProgress) => void; incrementalBaseline?: unknown; maxSnapshotBytes?: number; }

function unsupportedSummary(snapshot: Pick<GraphSnapshot, 'nodes'>): string | undefined {
  const byExtension = new Map<string, number>();
  for (const node of snapshot.nodes) if (node.importCoverage === 'unsupported') {
    const name = node.path.split('/').pop() ?? '';
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '(no extension)';
    byExtension.set(extension, (byExtension.get(extension) ?? 0) + 1);
  }
  if (!byExtension.size) return undefined;
  const top = [...byExtension].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return `Import connections are only extracted from JavaScript/TypeScript. Files shown without connections, by type: ${top.slice(0, 12).map(([extension, total]) => `${extension} ${count(total)}`).join(', ')}${top.length > 12 ? `, and ${top.length - 12} more types` : ''}.`;
}

/** Builds a pinned local-git snapshot from a registered mirror. */
export async function analyzeLocalRepository(input: AnalyzeInput, repository: LocalRepository, options: LocalAnalysisOptions = {}): Promise<GraphSnapshot> {
  let lastProgress = 0;
  const emit = (stage: AnalysisProgress['stage'], progress: number, message: string) => { options.signal?.throwIfAborted(); lastProgress = Math.max(lastProgress, progress); options.onProgress?.({ stage, progress: lastProgress, message }); };
  emit('indexing', 3, 'Resolving the local mirror revision');
  const contextRef = input.contextRef?.trim() || repository.defaultRef;
  const sha = await resolveLocalCommit(repository, contextRef, options.signal);
  emit('indexing', 12, 'Reading the pinned local tree');
  const reader = new LocalSnapshotReader(repository, options.signal);
  const { limits } = repository;
  const graph = await buildStaticGraph(reader, { owner: repository.owner, name: repository.name, fullName: repository.fullName }, sha, {
    maxFiles: limits.maxFiles, maxFilesCeiling: limits.maxFiles, maxSourceFiles: limits.maxSourceFiles, maxManifests: limits.maxManifests, maxSourceBytes: limits.maxSourceBytes,
    pathFilter: { include: repository.include, exclude: repository.exclude }, mappingOverride: repository.mapping, explainInventoryCap: true,
    signal: options.signal, incrementalBaseline: options.incrementalBaseline,
    onProgress: (analyzed, eligible) => emit('indexing', 24 + Math.round((analyzed / Math.max(eligible, 1)) * 45), `Indexed ${analyzed} source files from the local mirror`),
  });
  const reasons = [...graph.coverage.reasons];
  if (reader.invalidPaths) reasons.push(`${count(reader.invalidPaths)} tree entries have names that are not valid UTF-8 and are not inventoried.`);
  const unsupported = unsupportedSummary(graph);
  if (unsupported) reasons.push(unsupported);
  emit('sources', 76, 'Listing local commits and recorded footprints');
  const [page, recorded] = await Promise.all([gitCommitPage(repository, sha, 1, options.signal), footprintSources(repository, options.signal)]);
  const recordedIds = new Set(recorded.map(source => source.id));
  const sources = [...page.commits.map(commit => commitSource(repository, commit)).filter(source => !recordedIds.has(source.id)), ...recorded];
  const footprints = repository.footprints;
  if (footprints) {
    reasons.push(...footprints.problems.map(problem => `Footprint file: ${problem}`));
    const recordedCount = recorded.filter(source => source.comparisonKind === 'recorded').length;
    if (recordedCount) reasons.push(`${count(recordedCount)} changes come from a recorded footprint file instead of local Git history. Each one names its origin; selected-head imports are not analyzed for them.`);
  }
  const views = (footprints?.views ?? []).map(view => ({ id: view.id, title: view.title, ...(view.description ? { description: view.description } : {}), kind: view.kind, sourceIds: view.sourceIds.filter(id => sources.some(source => source.id === id)), omitted: view.omitted })).filter(view => view.sourceIds.length);
  const snapshot: GraphSnapshot = {
    schemaVersion: '1', id: `snapshot:${hash(`local-git:${repository.fullName}:${sha}:${ANALYZER_VERSION}:${repository.fingerprint}`)}`,
    repository: { owner: repository.owner, name: repository.name, fullName: repository.fullName, defaultBranch: repository.defaultRef, htmlUrl: repositoryRef(repository), label: repository.label },
    contextSha: sha, contextRef, nodes: graph.nodes, edges: graph.edges, groups: graph.hierarchy.groups, sources,
    coverage: { ...graph.coverage, status: reasons.length ? 'partial' : 'complete', reasons: unique(reasons) },
    createdAt: new Date().toISOString(), mode: 'local-git', sourcePagination: { pr: null, commit: page.nextPage },
    analyzerVersion: ANALYZER_VERSION, groupingRevision: graph.hierarchy.revision, hierarchy: graph.hierarchy, parserLimits: graph.parserLimits, incremental: graph.incremental,
    defaultSelection: [], ...(views.length ? { sourceViews: views } : {}),
  };
  const validated = validateGraphSnapshot(snapshot);
  const bytes = Buffer.byteLength(JSON.stringify(validated)); const ceiling = options.maxSnapshotBytes ?? limits.maxSnapshotBytes;
  if (bytes > ceiling) throw new LocalGitError(`The local snapshot is ${(bytes / 1_048_576).toFixed(1)} MiB, over the configured ${(ceiling / 1_048_576).toFixed(0)} MiB limit. Narrow the configured scope or lower maxFiles.`, 413, 'LOCAL_SNAPSHOT_LIMIT');
  emit('ready', 100, `Ready: ${graph.nodes.length} files and ${graph.edges.length} evidenced connections`);
  return validated;
}

/**
 * Splits one `diff-tree -z --raw --numstat` output into the name-status and numstat streams
 * that parseGitDiff reads. Raw records come first and always start with ':'; numstat
 * records start with a digit or '-'. Only record starts are inspected, never paths.
 */
function splitRawNumstat(output: Buffer): { names: Buffer; stats: Buffer } {
  const names: Buffer[] = []; const separator = Buffer.alloc(1);
  let start = 0;
  const next = () => {
    const end = output.indexOf(0, start);
    if (end === -1) throw new LocalGitError('Git returned an incomplete comparison.', 502, 'LOCAL_GIT_FAILED');
    const field = output.subarray(start, end); start = end + 1; return field;
  };
  while (start < output.length && output[start] === 0x3a) {
    const header = next(); const status = header.subarray(header.lastIndexOf(0x20) + 1);
    // Renames and copies (R100, C075) name the old path and then the new one.
    const paths = status[0] === 0x52 || status[0] === 0x43 ? 2 : 1;
    names.push(status, separator);
    for (let index = 0; index < paths; index++) names.push(next(), separator);
  }
  return { names: Buffer.concat(names), stats: output.subarray(start) };
}
interface LocalDiff { files: GitDiffFile[]; renamesLimited: boolean; }
/**
 * One diff-tree run per source: rename detection (bounded by GIT_RENAME_LIMIT) runs once and
 * yields both the statuses and the line counts.
 */
async function localDiff(repository: LocalRepository, base: string | undefined, head: string, signal?: AbortSignal): Promise<LocalDiff> {
  const range = base && base !== EMPTY_GIT_TREE ? [base, head] : ['--root', head];
  let renamesLimited = false;
  const output = await runLocalGit(repository.gitDir, ['diff-tree', '-r', '-z', '--no-commit-id', '--no-ext-diff', '--no-textconv', '-M50%', '--raw', '--numstat', ...range], { signal, maxOutputBytes: 128 * 1_048_576, timeoutMs: 120_000, onRenameLimit: () => { renamesLimited = true; } });
  const { names, stats } = splitRawNumstat(output);
  try { return { files: parseGitDiff(names, stats, repository.limits.maxChangedFiles), renamesLimited }; }
  catch (error) {
    // The shared parser speaks for the GitHub fallback; local mode reports its own codes.
    if (!(error instanceof GitHubError)) throw error;
    if (error.code === 'GIT_FALLBACK_LIMIT') throw new LocalGitError(`The comparison changes more than ${count(repository.limits.maxChangedFiles)} files, the configured maxChangedFiles limit.`, 413, 'LOCAL_DIFF_LIMIT');
    if (error.code === 'INVALID_SOURCE_PATH') throw new LocalGitError('The comparison has file names that are not valid UTF-8 or are unsafe.', 502, 'LOCAL_INVALID_PATH');
    throw new LocalGitError('Git returned a comparison that could not be read.', 502, 'LOCAL_GIT_FAILED');
  }
}
/** Why one source's comparison failed, in words that name no path. */
function diffFailure(label: string, error: LocalGitError, repository: LocalRepository): string {
  if (error.code === 'LOCAL_DIFF_LIMIT') return `${label}: the comparison changes more than ${count(repository.limits.maxChangedFiles)} files (the configured maxChangedFiles limit), so this change is not loaded.`;
  if (error.code === 'LOCAL_GIT_LIMIT') return `${label}: the local Git comparison exceeded its time or output budget, so this change is not loaded.`;
  if (error.code === 'LOCAL_INVALID_PATH') return `${label}: the comparison has file names that are not valid UTF-8 or are unsafe, so this change is not loaded.`;
  return `${label}: the local mirror could not compare this change, so it is not loaded.`;
}
const renameLimitReason = (label: string) => `${label}: Git skipped rename detection because the change adds and removes too many files to pair (about ${count(GIT_RENAME_LIMIT)} of each at most); renamed files may show as a removal and an addition.`;
const asApiFiles = (files: GitDiffFile[]): ApiFile[] => files.map(file => ({ filename: file.filename, ...(file.previous_filename ? { previous_filename: file.previous_filename } : {}), status: file.status, additions: file.additions, deletions: file.deletions, ...(file.binary ? { binary: true } : {}) }));

export interface LocalSourceOptions { signal?: AbortSignal; onProgress?: (progress: AnalysisProgress) => void; }

/** Where another source's head sits relative to the head being loaded. */
type Relation = 'ancestor' | 'descendant' | 'unrelated';
/** The commit a Git-backed source ends at. Recorded footprints have no place in the mirror's history. */
function gitHead(source: ChangeSource | undefined): string | undefined {
  if (!source || source.comparisonKind === 'recorded') return undefined;
  const head = source.kind === 'commit' ? source.sha : source.headSha;
  return head && SHA.test(head) ? head.toLowerCase() : undefined;
}
/** One merge-base answers both directions: it equals the ancestor, or neither commit when the lines diverged. */
async function relate(repository: LocalRepository, head: string, other: string, signal?: AbortSignal): Promise<Relation | undefined> {
  if (head === other) return undefined;
  const base = (await tryGit(repository, ['merge-base', head, other], { signal, maxOutputBytes: 256 }))?.toString('utf8').trim().toLowerCase();
  if (!base || !SHA.test(base)) return undefined;
  return base === other ? 'ancestor' : base === head ? 'descendant' : 'unrelated';
}

/**
 * Selected sources load in an order that anchors each file at the context snapshot first.
 * - Commits the context already contains load newest first. Their renames then chain back
 *   from the context file through each older path.
 * - Commits the context does not contain (other branches, newer work) load oldest first
 *   from where they left the context's history. A file's addition then maps before later
 *   changes to it.
 * - Recorded footprints have no place in the mirror and load in ID order, then anything Git
 *   could not place (for example history too large to order) by date.
 * The order depends on the history only, never on the requested order.
 */
async function localLoadOrder(repository: LocalRepository, sources: ChangeSource[], contextSha: string, signal?: AbortSignal): Promise<ChangeSource[]> {
  const heads = unique(sources.filter(source => !source.loaded).map(gitHead).filter((head): head is string => Boolean(head)));
  const rank = new Map<string, number>();
  const list = async (args: string[]) => {
    try { return (await tryGit(repository, ['rev-list', '--topo-order', ...args], { signal, maxOutputBytes: 8 * 1_048_576, timeoutMs: 30_000 }))?.toString('utf8').split('\n').filter(sha => SHA.test(sha)).map(sha => sha.toLowerCase()); }
    catch (error) { if (error instanceof LocalGitError && error.code === 'LOCAL_GIT_LIMIT') return undefined; throw error; }
  };
  if (heads.length && SHA.test(contextSha)) {
    const ahead = await list(['--reverse', ...heads, `^${contextSha}`]);
    if (ahead) {
      const outside = new Set(ahead);
      const contained = heads.filter(head => !outside.has(head));
      let offset = 0;
      if (contained.length > 1) {
        const base = (await tryGit(repository, ['merge-base', '--octopus', ...contained], { signal, maxOutputBytes: 256 }))?.toString('utf8').trim().toLowerCase();
        const newestFirst = await list([...contained, ...(base && SHA.test(base) ? [`^${base}`] : [])]);
        if (newestFirst) { newestFirst.forEach((sha, index) => rank.set(sha, index)); if (base && SHA.test(base)) rank.set(base, newestFirst.length); offset = newestFirst.length + 1; }
      } else if (contained.length === 1) { rank.set(contained[0]!, 0); offset = 1; }
      ahead.forEach((sha, index) => rank.set(sha, offset + index));
    }
  }
  const placed = (source: ChangeSource) => { const head = source.loaded ? undefined : gitHead(source); return head ? rank.get(head) : undefined; };
  const time = (source: ChangeSource) => Date.parse(String(source.sourceUpdatedAt ?? '')) || Number.MAX_SAFE_INTEGER;
  const group = (source: ChangeSource) => placed(source) !== undefined ? 0 : source.comparisonKind === 'recorded' ? 1 : 2;
  return [...sources].sort((a, b) => group(a) - group(b) || (group(a) === 0 ? placed(a)! - placed(b)! : 0) || (group(a) === 2 ? time(a) - time(b) : 0) || a.id.localeCompare(b.id));
}

/**
 * Judges same-path source-only files by history. `touched` holds every loaded change per file
 * identity; `related` holds whether each other source's head is on the same line of history as
 * the one being loaded (one is an ancestor of the other) or on another line.
 * - On one line, a path is one file: a change joins the file that its line already touched, so
 *   an addition joins later edits of it that loaded first.
 * - Across lines, only an addition separates: an addition does not join a file that only
 *   another line touched, and no change joins a file that another line added.
 * - Anything history does not settle (recorded footprints, mixed lines) is left to the path rules.
 */
function lineageJudge(sourceId: string, related: Map<string, Relation | undefined>, touched: Map<string, Map<string, ChangeStatus>>): ChangeLineage {
  return (node: FileNode, file: ApiFile) => {
    if (node.presence !== 'source-only' && node.presence !== 'deleted') return undefined;
    const rows = [...(touched.get(node.id) ?? [])].filter(([other]) => other !== sourceId).map(([other, status]) => ({ relation: related.get(other), status }));
    if (!rows.length) return undefined;
    const sameLine = rows.filter(row => row.relation === 'ancestor' || row.relation === 'descendant');
    const otherLine = rows.filter(row => row.relation === 'unrelated');
    if (file.status === 'added') {
      if (sameLine.length === rows.length) return 'same';
      return otherLine.length && !sameLine.length ? 'other' : undefined;
    }
    if (sameLine.length) return 'same';
    return otherLine.some(row => row.status === 'added') ? 'other' : undefined;
  };
}

/** Loads selected footprints from the mirror or the recorded file, then a bounded head layer. */
export async function loadLocalSourceChanges(snapshot: GraphSnapshot, kind: 'pr' | 'commit', ids: string[], repository: LocalRepository, options: LocalSourceOptions = {}): Promise<GraphSnapshot> {
  if (kind !== 'pr' && kind !== 'commit') throw new LocalGitError('Choose pull requests or commits.', 400, 'INVALID_SOURCE');
  if (snapshot.mode !== 'local-git' || snapshot.repository.fullName.toLowerCase() !== repository.fullName.toLowerCase()) throw new LocalGitError('This snapshot does not belong to the registered local repository.', 400, 'INVALID_SOURCE');
  const selection = unique(ids);
  if (selection.length > MAX_SELECTION) throw new LocalGitError(`Select up to ${MAX_SELECTION} changes at once.`, 400, 'SELECTION_LIMIT');
  const result = structuredClone(snapshot); const reasons = [...result.coverage.reasons];
  const records = new Map((repository.footprints?.records ?? []).map(record => [record.key, record]));
  const selected = selection.map(id => {
    const source = result.sources.find(item => item.id === id && item.kind === kind);
    if (!source) throw new LocalGitError('Selected source is not part of this repository snapshot. Refresh the source list.', 400, 'UNKNOWN_SOURCE');
    return source;
  });
  // Every loaded change per file identity, kept current while this request maps more sources.
  const touched = new Map<string, Map<string, ChangeStatus>>();
  const touch = (source: ChangeSource) => { for (const file of source.files) { let rows = touched.get(file.fileId); if (!rows) touched.set(file.fileId, rows = new Map()); rows.set(source.id, file.status); } };
  for (const source of result.sources) if (source.loaded) touch(source);
  const relations = new Map<string, Relation | undefined>();
  const byId = new Map(result.sources.map(source => [source.id, source]));
  for (const [index, source] of (await localLoadOrder(repository, selected, result.contextSha, options.signal)).entries()) {
    options.signal?.throwIfAborted();
    const id = source.id;
    if (source.loaded) continue;
    options.onProgress?.({ stage: 'sources', progress: Math.round((index / Math.max(selection.length, 1)) * 100), message: `Loading ${source.label}` });
    let files: ApiFile[]; let sourceReasons: string[] = [];
    // One source's oversized or unreadable comparison fails that source only; the others still load.
    const compare = async (base: string | undefined, head: string): Promise<ApiFile[] | undefined> => {
      try {
        const diff = await localDiff(repository, base, head, options.signal);
        if (diff.renamesLimited) { const reason = renameLimitReason(source.label); sourceReasons.push(reason); reasons.push(reason); }
        return asApiFiles(diff.files);
      } catch (error) {
        if (!(error instanceof LocalGitError) || error.code === 'ABORTED') throw error;
        source.loaded = false; source.files = [];
        source.coverage = { status: 'failed', reasons: [diffFailure(source.label, error, repository)] };
        reasons.push(...source.coverage.reasons);
        return undefined;
      }
    };
    if (source.comparisonKind === 'recorded') {
      const record = records.get(source.id);
      if (!record?.files) {
        source.loaded = false;
        source.coverage = { status: 'failed', reasons: [`${source.label}: no recorded file list and no commits in the local mirror; this footprint cannot be loaded.`] };
        reasons.push(...source.coverage.reasons);
        continue;
      }
      files = record.files.map(file => ({ filename: file.path, ...(file.previousPath ? { previous_filename: file.previousPath } : {}), status: file.status, additions: file.additions ?? 0, deletions: file.deletions ?? 0 }));
      sourceReasons = recordReasons(record, repository);
      source.fileEvidence = 'local-footprint-file';
      source.importCoverage = { status: 'unsupported', reasons: ['Recorded footprint: no selected-head import layer is built for files that were not read from the local mirror.'] };
    } else if (kind === 'commit') {
      if (!source.sha || !SHA.test(source.sha) || id !== `commit:${source.sha}`) throw new LocalGitError('Invalid commit ID.', 400, 'INVALID_SOURCE');
      const commit = await readCommit(repository, source.sha, options.signal);
      if (!commit) throw new LocalGitError('The selected commit is not in the local mirror.', 404, 'LOCAL_REF');
      source.baseSha = commit.parents[0] ?? EMPTY_GIT_TREE; source.headSha = commit.sha; source.comparisonKind = commit.parents.length ? 'first-parent' : 'empty-tree'; source.mergeCommit = commit.parents.length > 1;
      const compared = await compare(commit.parents[0], commit.sha);
      if (!compared) continue;
      files = compared; source.fileEvidence = 'local-git-diff';
    } else {
      const record = records.get(source.id);
      const base = source.baseRefSha ?? record?.baseSha, head = source.headSha ?? record?.headSha;
      if (!base || !head || !SHA.test(base) || !SHA.test(head)) throw new LocalGitError('Invalid pull request footprint.', 400, 'INVALID_SOURCE');
      const forkPoint = (await tryGit(repository, ['merge-base', base, head], { signal: options.signal, maxOutputBytes: 256 }))?.toString('utf8').trim().toLowerCase();
      if (!forkPoint || !SHA.test(forkPoint)) {
        delete source.baseSha; source.baseRefSha = base; source.comparisonResolved = false; source.loaded = false;
        source.coverage = { status: 'failed', reasons: [`${source.label}: the recorded base and head share no merge base in the local mirror.`] };
        reasons.push(...source.coverage.reasons);
        continue;
      }
      source.baseRefSha = base; source.baseSha = forkPoint; source.headSha = head; source.comparisonKind = 'merge-base'; source.comparisonResolved = true;
      const compared = await compare(forkPoint, head);
      if (!compared) continue;
      files = compared; source.fileEvidence = 'local-git-diff';
    }
    source.comparisonAttemptedAt = new Date().toISOString(); source.comparedAt = source.comparisonAttemptedAt;
    source.version = `source:${hash(`${source.id}:${source.baseSha ?? ''}:${source.headSha ?? ''}:${source.comparisonKind}`)}`;
    // History, not path equality, decides which same-path file a Git-backed change belongs to.
    const head = gitHead(source); const related = new Map<string, Relation | undefined>();
    if (head) {
      const touchedPaths = new Set(files.flatMap(file => file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]));
      const others = new Set<string>();
      for (const node of result.nodes) {
        if (node.presence !== 'source-only' && node.presence !== 'deleted') continue;
        if (!touchedPaths.has(node.path) && !(Array.isArray(node.lineageAliases) && node.lineageAliases.some(alias => touchedPaths.has(alias)))) continue;
        for (const other of touched.get(node.id)?.keys() ?? []) if (other !== id) others.add(other);
      }
      for (const other of others) {
        const otherHead = gitHead(byId.get(other));
        if (!otherHead) continue;
        const key = `${head}:${otherHead}`;
        if (!relations.has(key)) relations.set(key, await relate(repository, head, otherHead, options.signal));
        related.set(other, relations.get(key));
      }
    }
    const canonical = toChanges(files, result, id, head ? { lineage: lineageJudge(id, related, touched) } : {});
    let paths: Map<string, string> | undefined;
    const identity = mergeChangesByIdentity(canonical.changes, fileId => (paths ??= new Map([...result.nodes, ...canonical.nodes].map(node => [node.id, node.path]))).get(fileId));
    if (identity.merged.length) {
      const total = identity.merged.length;
      const examples = identity.merged.slice(0, 3).map(item => `${item.paths.join(' + ')} (${item.statuses.join(' + ')}, shown as ${item.status})`).join('; ');
      const reason = `${source.label}: ${count(total)} ${total === 1 ? 'file appears' : 'files appear'} under more than one path. A rename in another loaded change links those paths to one file, so each is shown once: ${examples}${total > 3 ? `; and ${count(total - 3)} more` : ''}.`;
      sourceReasons.push(reason); reasons.push(reason);
    }
    source.files = identity.changes; source.loaded = true; touch(source);
    source.coverage = { status: sourceReasons.length ? 'partial' : 'complete', reasons: sourceReasons };
    result.nodes.push(...canonical.nodes);
    if (canonical.nodes.length) reasons.push('Selected-source-only files are visible, but import edges describe the pinned context snapshot. Imports from other source heads have not been analyzed.');
    if (canonical.nodes.some(node => node.ambiguousLineage)) reasons.push('Independent selected sources add the same path. Separate source-only identities are retained because content equality does not establish shared lineage.');
    if (source.comparisonKind === 'recorded') {
      const record = records.get(source.id)!; const missing = record.files?.filter(file => file.inHead === false).length ?? 0;
      reasons.push(`${source.label}: recorded file list (${record.origin}), not a Git comparison${missing ? `; ${count(missing)} recorded paths are absent from the head the footprint was built against` : ''}${record.notes.length ? `; footprint notes: ${record.notes.join('; ')}` : ''}.`);
    }
  }
  const membership = new Map<string, Set<string>>();
  for (const source of result.sources) for (const file of source.files) { if (!membership.has(file.fileId)) membership.set(file.fileId, new Set()); membership.get(file.fileId)!.add(source.id); }
  result.nodes = result.nodes.map(node => ({ ...node, sourceIds: [...(membership.get(node.id) ?? [])] }));
  const existingGroups = new Set(result.groups.map(group => group.id));
  result.groups.push(...deriveGroups(result.nodes.map(node => node.path)).filter(group => !existingGroups.has(group.id)));
  result.coverage = { ...result.coverage, status: reasons.length ? 'partial' : 'complete', reasons: unique(reasons) }; result.defaultSelection = selection;
  options.onProgress?.({ stage: 'ready', progress: 100, message: 'Selected change footprints are ready' });
  // Head layers exist only for commits that are present in the mirror.
  const withHeads = selection.filter(id => { const source = result.sources.find(item => item.id === id); return source?.loaded && source.comparisonKind !== 'recorded'; });
  const { limits } = repository;
  await enrichSelectedSourceDependencies(result, kind, withHeads, { reader: new LocalSnapshotReader(repository, options.signal), maxFiles: limits.maxFiles, maxFilesCeiling: limits.maxFiles, maxSourceBytes: limits.maxSourceBytes, maxSourceFiles: limits.maxSourceFiles, pathFilter: { include: repository.include, exclude: repository.exclude }, signal: options.signal });
  return validateGraphSnapshot(result);
}
