import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubError, parseRepository } from '@patchwork/github';

export const EMPTY_GIT_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export interface GitDiffFile { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; binary?: boolean; }
export interface GitDiffRequest { repository: string; baseSha: string; headSha: string; signal?: AbortSignal; comparisonKind?: 'merge-base'; }
export interface GitDiffComparison { files: GitDiffFile[]; baseSha: string; headSha: string; }
export interface GitFallbackLimits { timeoutMs?: number; maxDiskBytes?: number; maxOutputBytes?: number; maxFiles?: number; }
const shaPattern = /^[a-f0-9]{40}$/i;

// No inherited Git config, credentials, proxy commands, diff drivers or executable hooks.
export function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[name]) env[name] = process.env[name];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };
}
/**
 * Environment for reading an existing local mirror: the safe base plus switches that
 * stop promisor-remote lazy fetching and user-initiated protocol use, so a read can
 * never turn into a transfer even if a mirror were a partial clone.
 */
export function localSafeEnvironment(): NodeJS.ProcessEnv {
  return { ...safeEnvironment(), GIT_NO_LAZY_FETCH: '1', GIT_PROTOCOL_FROM_USER: '0', GIT_ALLOW_PROTOCOL: 'none', GIT_LITERAL_PATHSPECS: '1', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_SSH_COMMAND: 'false' };
}
/**
 * Configuration for reading an existing local mirror. Unlike the remote fallback it
 * enables no transport at all (protocol.allow=never with no https exception), so no
 * object can ever be fetched, and rename detection is unlimited for exact local diffs.
 */
export const LOCAL_SAFE_GIT_CONFIG: readonly string[] = Object.freeze(['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'credential.helper=', '-c', 'diff.renameLimit=0', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0']);
const config = ['-c', 'core.hooksPath=', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false', '-c', 'fetch.recurseSubmodules=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'diff.renameLimit=1000'];

async function diskUsage(path: string): Promise<number> {
  let size = 0;
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new GitHubError('Git fallback contained an unexpected symlink.', 502, 'GIT_FALLBACK_LIMIT');
    // Git atomically renames/removes temporary pack files while fetch is active.
    // A vanished entry is not a storage failure; the final stable scan still
    // enforces the budget before any diff is accepted.
    try { size += entry.isDirectory() ? await diskUsage(child) : (await stat(child)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return size;
}

async function runGit(args: string[], directory: string, limits: Required<GitFallbackLimits>, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...config, ...args], { cwd: directory, env: safeEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = []; let bytes = 0; let failure: Error | undefined; let checking = false;
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const aborted = () => stop(new GitHubError('Git fallback was canceled.', 499, 'ABORTED'));
    signal?.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(() => stop(new GitHubError('Git fallback exceeded its process time budget.', 504, 'GIT_FALLBACK_LIMIT')), limits.timeoutMs);
    const monitor = setInterval(() => {
      if (checking) return; checking = true;
      void diskUsage(directory).then(size => { if (size > limits.maxDiskBytes) stop(new GitHubError('Git fallback exceeded its disk budget.', 413, 'GIT_FALLBACK_LIMIT')); }).catch(() => stop(new GitHubError('Git fallback storage could not be checked.', 502, 'GIT_FALLBACK_LIMIT'))).finally(() => { checking = false; });
    }, 100);
    const consume = (chunk: Buffer, retain: boolean) => { bytes += chunk.length; if (bytes > limits.maxOutputBytes) stop(new GitHubError('Git fallback exceeded its output budget.', 413, 'GIT_FALLBACK_LIMIT')); else if (retain) output.push(chunk); };
    child.stdout.on('data', chunk => consume(chunk, true));
    child.stderr.on('data', chunk => consume(chunk, false)); // Never expose remote text, URLs or object content in errors.
    child.on('error', () => { failure ??= new GitHubError('Git fallback is unavailable on this host.', 502, 'GIT_FALLBACK_UNAVAILABLE'); });
    child.on('close', code => {
      clearTimeout(timer); clearInterval(monitor); signal?.removeEventListener('abort', aborted);
      if (failure) reject(failure);
      else if (code !== 0) reject(new GitHubError('Pinned Git objects could not be fetched or compared within the fallback bounds.', 502, 'GIT_FALLBACK_FAILED'));
      else resolve(Buffer.concat(output));
    });
  });
}

/** NUL parsing preserves tabs/newlines and never decodes a path as a shell argument. */
export function parseGitDiff(nameStatus: Buffer, numstat: Buffer, maxFiles = 10_000): GitDiffFile[] {
  const decode = (value: Buffer) => { try { return new TextDecoder('utf8', { fatal: true }).decode(value); } catch { throw new GitHubError('Git paths are not valid UTF-8; the fallback cannot safely identify them.', 502, 'INVALID_SOURCE_PATH'); } };
  const names = decode(nameStatus).split('\0'); const files: GitDiffFile[] = [];
  for (let index = 0; index < names.length && names[index];) {
    const kind = names[index++]!; const first = names[index++]!;
    const rename = kind.startsWith('R') || kind.startsWith('C'); const path = rename ? names[index++]! : first;
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || (rename && (!first || first.startsWith('/') || first.includes('\\') || first.split('/').includes('..')))) throw new GitHubError('Git returned an unsafe file path.', 502, 'INVALID_SOURCE_PATH');
    files.push({ filename: path, ...(rename ? { previous_filename: first } : {}), status: ({ A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied', T: 'modified' } as Record<string, string>)[kind[0]!] ?? 'modified', additions: 0, deletions: 0 });
    if (files.length > maxFiles) throw new GitHubError('Git fallback exceeded its changed-file budget.', 413, 'GIT_FALLBACK_LIMIT');
  }
  const stats = decode(numstat).split('\0'); const byPath = new Map(files.map(file => [file.filename, file])); const seen = new Set<string>();
  if (byPath.size !== files.length) throw new GitHubError('Git returned duplicate file paths.', 502, 'INVALID_RESPONSE');
  for (let index = 0; index < stats.length && stats[index];) {
    const item = stats[index++]!; const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(item);
    if (!match) throw new GitHubError('Git returned invalid diff statistics.', 502, 'INVALID_RESPONSE');
    let path = match[3]!;
    if (!path) { index++; path = stats[index++]!; } // -z rename: empty field, old name, new name.
    const file = byPath.get(path);
    if (!file || seen.has(path)) throw new GitHubError('Git diff statistics do not match file evidence.', 502, 'INVALID_RESPONSE');
    seen.add(path);
    file.binary = match[1] === '-' || match[2] === '-';
    file.additions = file.binary ? 0 : Number(match[1]); file.deletions = file.binary ? 0 : Number(match[2]);
    if (![file.additions, file.deletions].every(value => Number.isSafeInteger(value) && value >= 0)) throw new GitHubError('Git returned invalid line counts.', 502, 'INVALID_RESPONSE');
  }
  if (seen.size !== files.length) throw new GitHubError('Git returned incomplete diff statistics.', 502, 'INVALID_RESPONSE');
  return files;
}

/** Public-only, fresh bare repository: no checkout, submodules, hooks, filters, scripts or dependencies. */
export async function boundedGitDiff(request: GitDiffRequest, settings: GitFallbackLimits = {}): Promise<GitDiffFile[]> {
  return (await boundedGitComparison(request, settings)).files;
}

/** Resolves a merge base only from bounded fetched ancestry, never from the branch tip. */
export async function boundedGitComparison(request: GitDiffRequest, settings: GitFallbackLimits = {}): Promise<GitDiffComparison> {
  const repository = parseRepository(request.repository);
  if (!shaPattern.test(request.baseSha) || !shaPattern.test(request.headSha)) throw new GitHubError('Git fallback requires pinned SHA-1 objects.', 400, 'INVALID_REF');
  const limits = { timeoutMs: Math.min(Math.max(settings.timeoutMs ?? 20_000, 1), 60_000), maxDiskBytes: Math.min(settings.maxDiskBytes ?? 64 * 1024 * 1024, 256 * 1024 * 1024), maxOutputBytes: Math.min(settings.maxOutputBytes ?? 4 * 1024 * 1024, 16 * 1024 * 1024), maxFiles: Math.min(settings.maxFiles ?? 10_000, 20_000) };
  const directory = await mkdtemp(join(tmpdir(), 'patchwork-git-'));
  const deadline = Date.now() + limits.timeoutMs;
  const run = (args: string[]) => runGit(args, directory, { ...limits, timeoutMs: Math.max(1, deadline - Date.now()) }, request.signal);
  try {
    await run(['init', '--bare', '--template=', '.']);
    const url = `https://github.com/${repository.fullName}.git`;
    const depth = request.comparisonKind === 'merge-base' ? 128 : 1;
    for (const sha of [...new Set([request.baseSha, request.headSha])]) if (sha !== EMPTY_GIT_TREE) await run(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', `--depth=${depth}`, url, sha]);
    if (await diskUsage(directory) > limits.maxDiskBytes) throw new GitHubError('Git fallback exceeded its disk budget.', 413, 'GIT_FALLBACK_LIMIT');
    let baseSha = request.baseSha;
    if (request.comparisonKind === 'merge-base') {
      baseSha = (await run(['merge-base', request.baseSha, request.headSha])).toString('utf8').trim();
      if (!shaPattern.test(baseSha)) throw new GitHubError('The pinned merge base could not be established within the ancestry budget.', 502, 'GIT_FALLBACK_FAILED');
    }
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '-z'];
    const names = await run([...args, '--name-status', baseSha, request.headSha, '--']);
    const stats = await run([...args, '--numstat', baseSha, request.headSha, '--']);
    return { files: parseGitDiff(names, stats, limits.maxFiles), baseSha, headSha: request.headSha };
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
}
