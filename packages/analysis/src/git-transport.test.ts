import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authoredFileFacts } from '@patchwork/fixtures';
import { GraphSnapshotSchema, type ChangeSource, type GraphSnapshot } from '@patchwork/contracts';
import { clearGitHubCacheForTests } from '@patchwork/github';
import { boundedGitComparison } from './git-fallback';
import { loadSourceChanges } from './footprints';

// Production has no configurable Git origin. Only this test intercepts spawn's
// already-validated fixed HTTPS argument and directs it to an authored local repo.
// Git itself still performs real fetch/merge-base/diff in the fresh bare directory.
const transport = vi.hoisted(() => ({ origin: '', commands: [] as { args: string[]; cwd: string; env: NodeJS.ProcessEnv; shell: unknown }[] }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (command: string, args: string[], options: import('node:child_process').SpawnOptions) => {
    transport.commands.push({ args: [...args], cwd: String(options.cwd), env: { ...options.env }, shell: options.shell });
    const replaced = args.map(arg => arg === 'https://github.com/acme/tool.git' ? transport.origin : arg);
    return actual.spawn(command, ['-c', 'protocol.file.allow=always', ...replaced], options);
  } };
});

const execute = promisify(execFile);
let directory: string, root: string, main: string, fork: string, release: string, otherFork: string, forced: string, largeHead: string;
const unknownHead = 'f'.repeat(40);
async function git(...args: string[]) {
  return (await execute('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 'Authored fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Authored fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } })).stdout.trim();
}
async function commit(message: string) { await git('add', '-A'); await git('commit', '-m', message); return git('rev-parse', 'HEAD'); }
async function gitInput(input: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.hooksPath=', ...args], { cwd: directory, windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 'Authored fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Authored fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    child.stdin!.end(input);
  });
}
function source(number: number, baseSha: string, headSha: string): ChangeSource {
  return { id: `pr:${number}`, kind: 'pr', number, label: `#${number}`, title: 'Authored fork PR', url: `https://github.com/acme/tool/pull/${number}`, baseSha, headSha, comparisonKind: 'merge-base', files: [], loaded: false };
}
function snapshot(sources: ChangeSource[]): GraphSnapshot {
  return { schemaVersion: '1', id: 'snapshot:transport', repository: { owner: 'acme', name: 'tool', fullName: 'acme/tool', htmlUrl: 'https://github.com/acme/tool', defaultBranch: 'main' }, contextSha: main, contextRef: 'main', nodes: [{ ...authoredFileFacts('complete'), id: 'file:existing', path: 'src/existing.ts', groupId: 'folder:src', sourceIds: [] }], edges: [], groups: [{ id: 'folder:src', label: 'src' }], sources, coverage: { status: 'complete', reasons: [] }, createdAt: '2026-01-01T00:00:00Z', mode: 'github' };
}
const pull = (number: number, baseSha: string, headSha: string) => ({ number, title: 'Authored fork PR', html_url: `https://github.com/acme/tool/pull/${number}`, state: 'open', base: { sha: baseSha, ref: number === 1 ? 'main' : 'release' }, head: { sha: headSha, ref: 'fork-feature', repo: null }, changed_files: 1 });
const fetcher = (respond: (url: URL) => Response | unknown): typeof fetch => (async input => {
  const response = respond(new URL(String(input)));
  return response instanceof Response ? response : response === undefined ? new Response('', { status: 404 }) : Response.json(response);
}) as typeof fetch;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'patchwork-transport-origin-')); transport.origin = directory;
  await git('init', '--template=', '--initial-branch=main'); await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'src/existing.ts'), 'export const value = 1;\n'); root = await commit('root');
  await git('checkout', '-b', 'fork'); await writeFile(join(directory, 'src/existing.ts'), 'export const value = 2;\n'); fork = await commit('fork edit');
  await git('checkout', 'main'); await writeFile(join(directory, 'base-only.ts'), 'export const mainOnly = 1;\n'); main = await commit('different main base');
  await git('checkout', '-b', 'release', root); await writeFile(join(directory, 'release-only.ts'), 'export const releaseOnly = 1;\n'); release = await commit('release base');
  await git('checkout', '-b', 'other-fork'); await writeFile(join(directory, 'src/existing.ts'), 'export const value = 3;\n'); otherFork = await commit('other fork edit');
  await git('checkout', 'fork'); await git('reset', '--hard', root); await writeFile(join(directory, 'src/existing.ts'), 'export const value = 4;\n'); forced = await commit('force push replacement');
  // Hand-declared large golden: exactly 3,001 independent one-line additions.
  // Construct Git objects directly to avoid 3,001 working-tree filesystem writes.
  const blob = await gitInput('export const added = true;\n', 'hash-object', '-w', '--stdin');
  const rootTree = await git('rev-parse', `${root}^{tree}`);
  const original = await git('ls-tree', rootTree);
  const entries = Array.from({ length: 3001 }, (_, index) => `100644 blob ${blob}\tlarge-${String(index).padStart(4, '0')}.ts`).join('\n');
  const tree = await gitInput(`${original}\n${entries}\n`, 'mktree');
  largeHead = await gitInput('authored 3001-file addition\n', 'commit-tree', tree, '-p', root);
  await git('update-ref', 'refs/heads/large', largeHead);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); });
beforeEach(() => { clearGitHubCacheForTests(); transport.commands.length = 0; });

describe('actual pinned Git transport fallback goldens', () => {
  it('resolves unavailable/deleted-fork 404 and 403 comparisons independently across differing bases', async () => {
    const result = await loadSourceChanges(snapshot([source(1, main, fork), source(2, release, otherFork)]), 'pr', ['pr:2', 'pr:1'], { maxRetries: 0, fetch: fetcher(url => {
      if (url.pathname.endsWith('/pulls/1')) return pull(1, main, fork);
      if (url.pathname.endsWith('/pulls/2')) return pull(2, release, otherFork);
      if (url.pathname.includes(`${main}...${fork}`)) return new Response('', { status: 404 });
      if (url.pathname.includes('/compare/')) return new Response('', { status: 403 });
    }) });
    expect(result.sources.map(item => [item.baseRefSha, item.baseSha, item.headSha])).toEqual([[main, root, fork], [release, release, otherFork]]);
    for (const item of result.sources) {
      expect(item).toMatchObject({ loaded: true, comparisonResolved: true, fileEvidence: 'bounded-git-diff', coverage: { status: 'complete' } });
      expect(item.files).toEqual([{ fileId: 'file:existing', path: 'src/existing.ts', status: 'modified', additions: 1, deletions: 1 }]);
    }
    expect(result.nodes[0]?.sourceIds).toEqual(['pr:1', 'pr:2']);
    expect(result.nodes.map(node => node.path)).not.toContain('base-only.ts');
    expect(result.nodes.map(node => node.path)).not.toContain('release-only.ts');
    expect(transport.commands.some(call => call.args.includes('merge-base'))).toBe(true);
    for (const call of transport.commands) {
      expect(call.args).not.toContain('checkout'); expect(call.args).toContain('core.hooksPath=');
      expect(call.shell).toBe(false); expect(call.env.GIT_CONFIG_NOSYSTEM).toBe('1'); expect(call.env.GITHUB_TOKEN).toBeUndefined();
      if (call.args.includes('fetch')) { expect(call.args).toContain('https://github.com/acme/tool.git'); expect(call.args).toContain('--depth=128'); }
    }
    for (const cwd of new Set(transport.commands.map(call => call.cwd))) await expect(access(cwd)).rejects.toThrow();
  });

  it('retains other exact selections when unavailable fork objects cannot be fetched within fallback', async () => {
    const result = await loadSourceChanges(snapshot([source(1, main, unknownHead), source(2, release, otherFork)]), 'pr', ['pr:1', 'pr:2'], { maxRetries: 0, fetch: fetcher(url => {
      if (url.pathname.endsWith('/pulls/1')) return pull(1, main, unknownHead);
      if (url.pathname.endsWith('/pulls/2')) return pull(2, release, otherFork);
      if (url.pathname.includes(`${main}...${unknownHead}`)) return new Response('', { status: 404 });
      if (url.pathname.includes('/compare/')) return { merge_base_commit: { sha: release }, files: [{ filename: 'src/existing.ts', status: 'modified', additions: 1, deletions: 1 }] };
    }) });
    expect(result.sources[0]).toMatchObject({ loaded: false, comparisonResolved: false, baseRefSha: main, headSha: unknownHead, files: [], coverage: { status: 'partial' } });
    expect(result.sources[0]?.baseSha).toBeUndefined();
    expect(result.sources[0]?.comparedAt).toBeUndefined(); expect(result.sources[0]?.version).toBeUndefined();
    expect(result.sources[0]?.comparisonAttemptedAt).toEqual(expect.any(String));
    expect(result.sources[1]).toMatchObject({ loaded: true, files: [{ fileId: 'file:existing', path: 'src/existing.ts', status: 'modified', additions: 1, deletions: 1 }] });
    expect(result.coverage.status).toBe('partial'); expect(GraphSnapshotSchema.safeParse(result).success).toBe(true);
    const invalid = structuredClone(result); invalid.sources[0]!.loaded = true;
    expect(GraphSnapshotSchema.safeParse(invalid).success).toBe(false);
    const fabricated = structuredClone(result); fabricated.sources[0]!.baseSha = main;
    expect(GraphSnapshotSchema.safeParse(fabricated).success).toBe(false);
  });

  it('rejects force-push during actual fallback and leaves original snapshot pins/changes untouched', async () => {
    const input = snapshot([source(1, main, fork)]); let completedFallback = false;
    await expect(loadSourceChanges(input, 'pr', ['pr:1'], { maxRetries: 0,
      gitComparisonFallback: async request => { const result = await boundedGitComparison(request); completedFallback = true; return result; },
      fetch: fetcher(url => {
        if (url.pathname.endsWith('/pulls/1')) return pull(1, main, completedFallback && url.searchParams.has('state_check') ? forced : fork);
        if (url.pathname.includes('/compare/')) return new Response('', { status: 404 });
      }),
    })).rejects.toMatchObject({ code: 'STALE_SOURCE', status: 409 });
    expect(input.sources[0]).toMatchObject({ headSha: fork, baseSha: main, loaded: false, files: [] });
    expect(input.nodes[0]?.sourceIds).toEqual([]);
  });

  it('keeps original exact objects but marks explicit refresh when post-fallback PR refs cannot be rechecked', async () => {
    const result = await loadSourceChanges(snapshot([source(1, main, fork)]), 'pr', ['pr:1'], { maxRetries: 0, fetch: fetcher(url => {
      if (url.pathname.endsWith('/pulls/1')) return url.searchParams.has('state_check') ? new Response('', { status: 404 }) : pull(1, main, fork);
      if (url.pathname.includes('/compare/')) return new Response('', { status: 404 });
    }) });
    expect(result.sources[0]).toMatchObject({ loaded: true, baseSha: root, headSha: fork, refreshRequired: true, coverage: { status: 'partial' } });
    expect(result.sources[0]?.files).toHaveLength(1);
  });

  it('replaces the 3000-file API cap with all 3001 actual Git golden additions', async () => {
    const file = (index: number) => ({ filename: `large-${String(index).padStart(4, '0')}.ts`, status: 'added', additions: 1, deletions: 0 });
    const result = await loadSourceChanges(snapshot([source(1, root, largeHead)]), 'pr', ['pr:1'], { maxRetries: 0, maxSourceFiles: 0, fetch: fetcher(url => {
      if (url.pathname.endsWith('/pulls/1')) return { ...pull(1, root, largeHead), changed_files: 3001 };
      if (url.pathname.includes('/compare/')) return { merge_base_commit: { sha: root }, files: Array.from({ length: 300 }, (_, index) => file(index)) };
      if (url.pathname.endsWith('/files')) return Array.from({ length: 100 }, (_, index) => file((Number(url.searchParams.get('page')) - 1) * 100 + index));
    }) });
    expect(result.sources[0]).toMatchObject({ baseSha: root, headSha: largeHead, fileEvidence: 'bounded-git-diff', coverage: { status: 'complete' } });
    expect(result.sources[0]?.files).toHaveLength(3001);
    expect(new Set(result.sources[0]?.files.map(item => item.fileId)).size).toBe(3001);
    expect(result.sources[0]?.files.map(({ path, status, additions, deletions }) => ({ filename: path, status, additions, deletions }))).toEqual(Array.from({ length: 3001 }, (_, index) => file(index)));
    expect(transport.commands.filter(call => call.args.includes('fetch')).every(call => call.args.includes('--depth=1'))).toBe(true);
  });

  it('enforces process-output/disk budgets and cleans the bare directory on failure', async () => {
    await expect(boundedGitComparison({ repository: 'acme/tool', baseSha: main, headSha: fork, comparisonKind: 'merge-base' }, { maxOutputBytes: 1 })).rejects.toMatchObject({ code: 'GIT_FALLBACK_LIMIT' });
    for (const cwd of new Set(transport.commands.map(call => call.cwd))) await expect(access(cwd)).rejects.toThrow();
    transport.commands.length = 0;
    await expect(boundedGitComparison({ repository: 'acme/tool', baseSha: main, headSha: fork, comparisonKind: 'merge-base' }, { maxDiskBytes: 1 })).rejects.toMatchObject({ code: 'GIT_FALLBACK_LIMIT' });
    for (const cwd of new Set(transport.commands.map(call => call.cwd))) await expect(access(cwd)).rejects.toThrow();
  });

  it('does not catch current authorization failures or an invalid credential as a fallback opportunity', async () => {
    for (const location of ['metadata', 'comparison']) {
      await expect(loadSourceChanges(snapshot([source(1, main, fork)]), 'pr', ['pr:1'], { maxRetries: 0, fetch: fetcher(url => {
        if (url.pathname.endsWith('/pulls/1')) return location === 'metadata' ? new Response('', { status: 403 }) : pull(1, main, fork);
        if (url.pathname.includes('/compare/')) return new Response('', { status: 401 });
      }) })).rejects.toMatchObject({ code: location === 'metadata' ? 'ACCESS_DENIED' : 'AUTH_FAILED' });
      expect(transport.commands).toHaveLength(0); clearGitHubCacheForTests();
    }
  });
});
