import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphSnapshotSchema } from '@patchwork/contracts';
import { createGitHistoryFixture, type GitHistoryFixture } from '../../fixtures/src/git-history';

// Record every process this module starts. The real spawn still runs, so the test
// exercises actual Git against a real mirror.
const spawned = vi.hoisted(() => [] as { command: string; args: string[]; shell: unknown; cwd: unknown }[]);
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: ((command: string, args: string[], options: { shell?: unknown; cwd?: unknown }) => { spawned.push({ command, args: [...args], shell: options?.shell, cwd: options?.cwd }); return actual.spawn(command, args, options as never); }) as typeof actual.spawn };
});

const { analyzeLocalRepository, listLocalRepositorySources, loadLocalSourceChanges, pinLocalAnalysisInput, runLocalGit, LOCAL_GIT_SUBCOMMANDS } = await import('./local-git');
const { loadLocalGitConfig } = await import('./local-git-config');
type Registry = Awaited<ReturnType<typeof loadLocalGitConfig>>;

const STATUS: Record<string, string> = { A: 'added', M: 'modified', D: 'removed', R100: 'renamed' };
let root: string, fixture: GitHistoryFixture, mirror: string, registry: Registry;
const repository = () => registry.get('local/fixture')!;
function writeConfig(name: string, extra: Record<string, unknown> = {}, limits: Record<string, unknown> = {}) {
  const path = join(root, `${name}.json`);
  writeFileSync(path, JSON.stringify({ version: 1, limits, repositories: [{ id: 'local/fixture', label: 'Fixture', gitDir: mirror, defaultRef: 'main', footprints: join(root, 'footprints.json'), ...extra }] }));
  return path;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'patchwork-local-git-'));
  fixture = createGitHistoryFixture(join(root, 'work'));
  mirror = join(root, 'mirror.git');
  execFileSync('git', ['clone', '--quiet', '--mirror', '--no-hardlinks', fixture.directory, mirror], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  writeFileSync(join(root, 'footprints.json'), JSON.stringify({
    schemaVersion: 1,
    pulls: [
      { number: 1, title: 'PR A from mirror objects', baseSha: fixture.refs.root, headSha: fixture.refs.featureA, files: [{ path: 'ignored.ts', status: 'added' }] },
      { number: 2, title: 'PR B recorded only', headSha: 'f'.repeat(40), updatedAt: '2026-01-01T00:00:00.123456Z', files: [{ path: 'src/billing.ts', status: 'added' }, { path: 'src/shared.ts', status: 'modified', additions: 1, deletions: 1 }, { path: 'gone/old.ts', status: 'modified', inHead: false }] },
      { number: 3, title: 'PR C without evidence' },
      // A record that lists the merge's rename as a removal plus an addition, and one that lists both paths as modified.
      { number: 4, title: 'PR D rename recorded as two rows', updatedAt: '2025-12-01T00:00:00Z', files: [{ path: 'src/legacy.ts', status: 'removed' }, { path: 'src/renamed.ts', status: 'added', additions: 1 }] },
      { number: 5, title: 'PR E both paths modified', updatedAt: '2025-12-02T00:00:00Z', files: [{ path: 'src/legacy.ts', status: 'modified', additions: 1, deletions: 1 }, { path: 'src/renamed.ts', status: 'modified', additions: 2, deletions: 0 }] },
    ],
  }));
  registry = await loadLocalGitConfig(writeConfig('config'));
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

// Any network attempt from the local path fails the test.
const network = { fetch: vi.fn(), connect: vi.fn(), tls: vi.fn(), lookup: vi.fn() };
beforeEach(() => {
  spawned.length = 0;
  for (const spy of Object.values(network)) spy.mockReset();
  vi.stubGlobal('fetch', network.fetch.mockImplementation(() => { throw new Error('network access is not allowed in local mode'); }));
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(network.connect.mockImplementation(() => { throw new Error('socket connect is not allowed in local mode'); }) as never);
  vi.spyOn(tls, 'connect').mockImplementation(network.tls.mockImplementation(() => { throw new Error('tls is not allowed in local mode'); }) as never);
  vi.spyOn(dns, 'lookup').mockImplementation(network.lookup.mockImplementation(() => { throw new Error('dns is not allowed in local mode'); }) as never);
});
function expectOfflineGit(gitDir = repository().gitDir) {
  expect(network.fetch).not.toHaveBeenCalled();
  expect(network.connect).not.toHaveBeenCalled();
  expect(network.tls).not.toHaveBeenCalled();
  expect(network.lookup).not.toHaveBeenCalled();
  expect(spawned.length).toBeGreaterThan(0);
  for (const call of spawned) {
    expect(call.command).toBe('git');
    expect(call.shell).toBe(false);
    expect(call.args[0]).toBe(`--git-dir=${gitDir}`);
    const subcommand = call.args.find((arg, index) => index > 0 && !arg.startsWith('-') && call.args[index - 1] !== '-c');
    expect(LOCAL_GIT_SUBCOMMANDS.has(subcommand!)).toBe(true);
    for (const arg of call.args) {
      expect(arg).not.toMatch(/:\/\/|^git@|^ext::/);
      expect(['fetch', 'clone', 'ls-remote', 'pull', 'push', 'remote', 'submodule']).not.toContain(arg);
    }
    expect(call.args).toContain('protocol.allow=never');
  }
}

describe('local-git source', () => {
  it('inventories the golden root tree from the mirror with pinned import evidence', async () => {
    const snapshot = await analyzeLocalRepository({ repository: 'local/fixture', contextRef: fixture.refs.root }, repository());
    expect(GraphSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({ mode: 'local-git', contextSha: fixture.refs.root, repository: { fullName: 'local/fixture', htmlUrl: 'local-git://local/fixture' } });
    expect(snapshot.nodes.map(node => node.path)).toEqual([...fixture.golden.rootPaths]);
    const byId = new Map(snapshot.nodes.map(node => [node.id, node.path]));
    expect(snapshot.edges.map(edge => [byId.get(edge.source), byId.get(edge.target)])).toEqual([['src/main.ts', 'src/shared.ts']]);
    expect(snapshot.edges[0]!.evidence).toMatchObject({ path: 'src/main.ts', line: 1, specifier: './shared', snapshotSha: fixture.refs.root });
    expect(snapshot.nodes.find(node => node.path === 'vendor/widget')).toMatchObject({ fileKind: 'submodule' });
    expect(JSON.stringify(snapshot)).not.toContain(root);
    expectOfflineGit();
  });

  it('loads the merge commit as its first-parent delta, including the R100 rename', async () => {
    const snapshot = await analyzeLocalRepository({ repository: 'local/fixture' }, repository());
    const id = `commit:${fixture.refs.merge}`;
    expect(snapshot.sources.find(source => source.id === id)).toMatchObject({ comparisonKind: 'first-parent', baseSha: fixture.refs.root, loaded: false, url: `local-git://local/fixture/commit/${fixture.refs.merge}` });
    const loaded = await loadLocalSourceChanges(snapshot, 'commit', [id], repository());
    const source = loaded.sources.find(item => item.id === id)!;
    expect(source).toMatchObject({ loaded: true, fileEvidence: 'local-git-diff', mergeCommit: true, baseSha: fixture.refs.root, headSha: fixture.refs.merge, coverage: { status: 'complete' } });
    expect(source.files.map(file => ({ status: file.status, path: file.path, ...(file.previousPath ? { previousPath: file.previousPath } : {}) })))
      .toEqual(fixture.golden.featureA.map(change => ({ status: STATUS[change.status], path: change.path, ...('previousPath' in change ? { previousPath: change.previousPath } : {}) })));
    expect(source.files.find(file => file.path === 'src/auth.ts')).toMatchObject({ additions: 2, deletions: 0 });
    expect(source.importHeadSha).toBe(fixture.refs.merge);
    expectOfflineGit();
  });

  it('builds pull requests from mirror objects, from a recorded list, or marks them unloadable', async () => {
    const snapshot = await analyzeLocalRepository({ repository: 'local/fixture' }, repository());
    const pulls = new Map(snapshot.sources.filter(source => source.kind === 'pr').map(source => [source.id, source]));
    expect(pulls.get('pr:1')).toMatchObject({ comparisonKind: 'merge-base', baseRefSha: fixture.refs.root, headSha: fixture.refs.featureA });
    expect(pulls.get('pr:2')).toMatchObject({ comparisonKind: 'recorded', headSha: 'f'.repeat(40), loaded: false, coverage: { status: 'partial' }, sourceUpdatedAt: '2026-01-01T00:00:00.123Z' });
    expect(pulls.get('pr:3')).toMatchObject({ comparisonKind: 'recorded', loaded: false, coverage: { status: 'failed' } });
    const loaded = await loadLocalSourceChanges(snapshot, 'pr', ['pr:1', 'pr:2', 'pr:3'], repository());
    const result = new Map(loaded.sources.map(source => [source.id, source]));
    // Git wins when the pinned objects exist: the recorded list for PR 1 is not used.
    expect(result.get('pr:1')).toMatchObject({ loaded: true, fileEvidence: 'local-git-diff', baseSha: fixture.refs.root, comparisonResolved: true });
    expect(result.get('pr:1')!.files.map(file => file.path)).toEqual(fixture.golden.featureA.map(change => change.path));
    expect(result.get('pr:2')).toMatchObject({ loaded: true, fileEvidence: 'local-footprint-file', comparisonKind: 'recorded', importCoverage: { status: 'unsupported' } });
    expect(result.get('pr:2')!.files.map(file => [file.status, file.path])).toEqual([['added', 'src/billing.ts'], ['modified', 'src/shared.ts'], ['modified', 'gone/old.ts']]);
    expect(result.get('pr:2')!.coverage!.reasons.join(' ')).toMatch(/1 recorded paths are not in the head/);
    expect(loaded.nodes.find(node => node.path === 'gone/old.ts')).toMatchObject({ presence: 'source-only', sourceIds: ['pr:2'] });
    expect(result.get('pr:3')).toMatchObject({ loaded: false, files: [], coverage: { status: 'failed' } });
    expect(loaded.coverage.reasons.join(' ')).toMatch(/#2: recorded file list/);
    expect(new Set(loaded.nodes.find(node => node.path === 'src/shared.ts')!.sourceIds)).toEqual(new Set(['pr:1', 'pr:2']));
    expectOfflineGit();
  });

  it('loads a recorded PR after commits whose renames link two of its rows to one file', async () => {
    const snapshot = await analyzeLocalRepository({ repository: 'local/fixture' }, repository());
    // Without rename lineage the two recorded rows stay two files.
    const fresh = await loadLocalSourceChanges(snapshot, 'pr', ['pr:4'], repository());
    expect(fresh.sources.find(source => source.id === 'pr:4')!.files.map(file => [file.status, file.path])).toEqual([['removed', 'src/legacy.ts'], ['added', 'src/renamed.ts']]);
    // The merge commit renames src/legacy.ts to src/renamed.ts, so both rows now resolve to one node.
    const withCommit = await loadLocalSourceChanges(snapshot, 'commit', [`commit:${fixture.refs.merge}`], repository());
    expect(withCommit.nodes.find(node => node.path === 'src/renamed.ts')!.lineageAliases).toEqual(['src/legacy.ts', 'src/renamed.ts']);
    const loaded = await loadLocalSourceChanges(withCommit, 'pr', ['pr:4', 'pr:5'], repository());
    expect(GraphSnapshotSchema.safeParse(loaded).success).toBe(true);
    const node = loaded.nodes.find(item => item.path === 'src/renamed.ts')!;
    const renamed = loaded.sources.find(source => source.id === 'pr:4')!, modified = loaded.sources.find(source => source.id === 'pr:5')!;
    expect(renamed).toMatchObject({ loaded: true, coverage: { status: 'partial' } });
    expect(renamed.files).toEqual([{ fileId: node.id, path: 'src/renamed.ts', previousPath: 'src/legacy.ts', status: 'renamed', additions: 1, deletions: 0 }]);
    expect(modified.files).toEqual([{ fileId: node.id, path: 'src/renamed.ts', status: 'modified', additions: 3, deletions: 1 }]);
    expect(renamed.coverage!.reasons.join(' ')).toContain('#4: 1 file appears under more than one path. A rename in another loaded change links those paths to one file, so each is shown once: src/legacy.ts + src/renamed.ts (removed + added, shown as renamed).');
    expect(loaded.coverage.reasons.join(' ')).toContain('#5: 1 file appears under more than one path');
    expect(new Set(node.sourceIds)).toEqual(new Set([`commit:${fixture.refs.merge}`, 'pr:4', 'pr:5']));
    // The commit stays loaded with its own exact delta.
    expect(loaded.sources.find(source => source.id === `commit:${fixture.refs.merge}`)).toMatchObject({ loaded: true, coverage: { status: 'complete' } });
    expectOfflineGit();
  });

  it('pages first-parent commits and pins refs only through the mirror', async () => {
    const pinned = await pinLocalAnalysisInput({ repository: 'local/fixture', contextRef: 'feature-b' }, repository());
    expect(pinned).toEqual({ repository: 'local/fixture', contextRef: fixture.refs.featureB, displayContextRef: 'feature-b', mode: undefined });
    const page = await listLocalRepositorySources(repository(), 'commit', 1, fixture.refs.merge);
    expect(page.sources.map(source => source.sha)).toEqual([fixture.refs.merge, fixture.refs.root]);
    expect(page.nextPage).toBeNull();
    await expect(pinLocalAnalysisInput({ repository: 'local/fixture', contextRef: 'missing-branch' }, repository())).rejects.toMatchObject({ code: 'LOCAL_REF', status: 404 });
    for (const contextRef of ['--upload-pack=touch', 'main:src', 'main..feature-a', 'HEAD@{1}']) await expect(pinLocalAnalysisInput({ repository: 'local/fixture', contextRef }, repository())).rejects.toMatchObject({ code: 'LOCAL_REF', status: 400 });
    expectOfflineGit();
  });

  it('refuses every Git command outside the read-only allowlist and any remote-shaped argument', async () => {
    for (const args of [['fetch', 'origin'], ['clone', mirror, 'x'], ['remote', '-v'], ['ls-remote', 'origin'], ['submodule', 'update'], ['config', 'core.bare']]) await expect(runLocalGit(mirror, args)).rejects.toMatchObject({ code: 'LOCAL_GIT_DENIED' });
    for (const args of [['log', 'https://example.invalid/repo.git'], ['ls-tree', 'git@example.invalid:repo'], ['diff-tree', '--output=/tmp/x', 'HEAD'], ['log', '--ext-diff'], ['rev-parse', '--git-dir=/tmp']]) await expect(runLocalGit(mirror, args)).rejects.toMatchObject({ code: 'LOCAL_GIT_DENIED' });
    expect(spawned).toHaveLength(0);
  });

  it('reports configured scope and inventory caps as explicit coverage reasons', async () => {
    const scoped = (await loadLocalGitConfig(writeConfig('scoped', { exclude: ['generated/**', '**/*.bin'], limits: { maxFiles: 3 } }))).get('local/fixture')!;
    const snapshot = await analyzeLocalRepository({ repository: 'local/fixture', contextRef: fixture.refs.root }, scoped);
    expect(snapshot.nodes.map(node => node.path)).toEqual(['.gitmodules', 'src/deleted.ts', 'src/legacy.ts']);
    const reasons = snapshot.coverage.reasons.join('\n');
    expect(reasons).toContain('Configured scope excludes generated/**: 1 files are not inventoried.');
    expect(reasons).toContain('Configured scope excludes **/*.bin: 1 files are not inventoried.');
    expect(reasons).toContain('Inventory is limited to 3 of 6 files.');
    expect(reasons).toMatch(/alphabetical cut after src\/legacy\.ts: 3 files are missing\. Folders missing entirely: vendor \(1\)\. Folders cut part-way: src \(2\)\./);
    expect(snapshot.parserLimits).toMatchObject({ maxFiles: 3 });
  });

  it('fails explicitly instead of storing a snapshot over the configured size limit', async () => {
    await expect(analyzeLocalRepository({ repository: 'local/fixture' }, repository(), { maxSnapshotBytes: 2_000 })).rejects.toMatchObject({ code: 'LOCAL_SNAPSHOT_LIMIT', status: 413 });
  });
});

// Main renames notes/a.md twice (R1, R2); the context is main's head. A file that is not in the
// context snapshot: X adds it, Y (a child of X) changes it, and U on another branch adds the same
// path independently. X, Y and U fork from the base. Which commit loads first must not matter.
describe('local file identity follows history, not load order', () => {
  let lineageRegistry: Registry, gitDir: string;
  const refs: Record<'base' | 'r1' | 'r2' | 'x' | 'y' | 'u', string> = { base: '', r1: '', r2: '', x: '', y: '', u: '' };
  const lineage = () => lineageRegistry.get('local/lineage')!;
  const commitId = (name: keyof typeof refs) => `commit:${refs[name]}`;
  beforeAll(async () => {
    const work = join(root, 'lineage-work'); gitDir = join(root, 'lineage.git');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    const git = (args: string[], date = '2026-01-01T00:00:00Z') => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: work, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: 'utf8' }).trim();
    const put = (path: string, content: string) => { execFileSync('mkdir', ['-p', join(work, path, '..')]); writeFileSync(join(work, path), content); };
    const commit = (message: string, date: string) => { git(['add', '--all'], date); git(['commit', '--quiet', '-m', message], date); return git(['rev-parse', 'HEAD']); };
    execFileSync('mkdir', ['-p', work]);
    git(['init', '--quiet', '--object-format=sha1', '--initial-branch=main', '.']);
    put('README.md', 'base\n'); put('notes/a.md', 'note\n'); refs.base = commit('base', '2026-01-01T00:00:00Z');
    git(['mv', 'notes/a.md', 'notes/b.md'], '2026-01-01T01:00:00Z'); refs.r1 = commit('rename a to b', '2026-01-01T01:00:00Z');
    git(['mv', 'notes/b.md', 'notes/c.md'], '2026-01-01T02:00:00Z'); refs.r2 = commit('rename b to c', '2026-01-01T02:00:00Z');
    git(['checkout', '--quiet', '-b', 'line', refs.base]);
    put('src/new.ts', 'export const value = 1;\n'); put('src/gone.ts', 'export const gone = 1;\n'); refs.x = commit('add new and gone', '2026-01-02T00:00:00Z');
    put('src/new.ts', 'export const value = 2;\n'); execFileSync('rm', [join(work, 'src/gone.ts')]); refs.y = commit('change new, delete gone', '2026-01-03T00:00:00Z');
    git(['checkout', '--quiet', '-b', 'other', refs.base]);
    put('src/new.ts', 'export const other = true;\n'); refs.u = commit('add new independently', '2026-01-02T12:00:00Z');
    execFileSync('git', ['clone', '--quiet', '--mirror', '--no-hardlinks', work, gitDir], { env });
    writeFileSync(join(root, 'lineage-footprints.json'), JSON.stringify({ schemaVersion: 1, commits: (['y', 'u', 'x'] as const).map(name => ({ sha: refs[name] })) }));
    const path = join(root, 'lineage.json');
    writeFileSync(path, JSON.stringify({ version: 1, limits: {}, repositories: [{ id: 'local/lineage', label: 'Lineage', gitDir, defaultRef: 'main', footprints: join(root, 'lineage-footprints.json') }] }));
    lineageRegistry = await loadLocalGitConfig(path);
  });
  const analyze = () => analyzeLocalRepository({ repository: 'local/lineage' }, lineage());
  const load = (snapshot: GraphSnapshot, ids: string[]) => loadLocalSourceChanges(snapshot, 'commit', ids, lineage());
  /** The file identity each loaded commit gives a path. */
  const identity = (snapshot: GraphSnapshot, path: string) => Object.fromEntries((['base', 'r1', 'r2', 'x', 'y', 'u'] as const).flatMap(name => {
    const file = snapshot.sources.find(source => source.id === commitId(name))?.files.find(change => change.path === path);
    return file ? [[name, file.fileId]] : [];
  }));
  type GraphSnapshot = Awaited<ReturnType<typeof analyzeLocalRepository>>;

  it('keeps one file for an addition and a later change, loaded together or one at a time', async () => {
    const snapshot = await analyze();
    expect(snapshot.nodes.map(node => node.path).sort()).toEqual(['README.md', 'notes/c.md']);
    const together = [await load(snapshot, [commitId('y'), commitId('x')]), await load(snapshot, [commitId('x'), commitId('y')])];
    // The change loads first, then the addition joins it.
    const incremental = await load(await load(snapshot, [commitId('y')]), [commitId('y'), commitId('x')]);
    for (const result of [...together, incremental]) {
      expect(GraphSnapshotSchema.safeParse(result).success).toBe(true);
      for (const path of ['src/new.ts', 'src/gone.ts']) {
        const ids = identity(result, path);
        expect(Object.keys(ids).sort()).toEqual(['x', 'y']);
        expect(ids.x).toBe(ids.y);
        expect(result.nodes.filter(node => node.path === path)).toHaveLength(1);
        expect(new Set(result.nodes.find(node => node.id === ids.x)!.sourceIds)).toEqual(new Set([commitId('x'), commitId('y')]));
      }
      expect(result.coverage.reasons.join(' ')).not.toContain('shared lineage');
    }
    // Together, the addition is mapped first whatever the requested order, so both requests agree.
    expect(together[0]!.nodes.map(node => node.id)).toEqual(together[1]!.nodes.map(node => node.id));
    const progress: string[] = [];
    await loadLocalSourceChanges(snapshot, 'commit', [commitId('y'), commitId('u'), commitId('x')], lineage(), { onProgress: event => { if (event.stage === 'sources') progress.push(event.message); } });
    // Ancestors first: X before its child Y; U (another line) only needs a stable place.
    expect(progress.indexOf(`Loading ${refs.x.slice(0, 7)}`)).toBeLessThan(progress.indexOf(`Loading ${refs.y.slice(0, 7)}`));
    expect(progress).toHaveLength(3);
    expectOfflineGit(lineage().gitDir);
  });

  it('chains the renames of commits the context contains back to the context file', async () => {
    const snapshot = await analyze();
    // The root commit adds notes/a.md; R1 and R2 rename it. All three are in the context's history.
    for (const ids of [[commitId('base'), commitId('r1'), commitId('r2')], [commitId('r2'), commitId('base'), commitId('r1')]]) {
      const result = await load(snapshot, ids);
      const context = result.nodes.find(node => node.path === 'notes/c.md')!;
      expect(context.presence).toBe('context');
      expect(result.sources.find(source => source.id === commitId('base'))!.files.find(file => file.path === 'notes/a.md')).toMatchObject({ fileId: context.id, status: 'added' });
      expect(identity(result, 'notes/b.md')).toEqual({ r1: context.id });
      expect(identity(result, 'notes/c.md')).toEqual({ r2: context.id });
      expect(context.lineageAliases).toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md']);
      expect(result.nodes.filter(node => node.presence !== 'context')).toEqual([]);
    }
    expectOfflineGit(lineage().gitDir);
  });

  it('keeps an independent addition on another branch apart in every load order', async () => {
    const snapshot = await analyze();
    const orders: string[][][] = [
      [[commitId('x'), commitId('y'), commitId('u')]],
      [[commitId('u')], [commitId('u'), commitId('y')], [commitId('u'), commitId('y'), commitId('x')]],
      [[commitId('y')], [commitId('y'), commitId('u')], [commitId('y'), commitId('u'), commitId('x')]],
      [[commitId('u')], [commitId('u'), commitId('x')], [commitId('u'), commitId('x'), commitId('y')]],
      [[commitId('x')], [commitId('x'), commitId('u')], [commitId('x'), commitId('u'), commitId('y')]],
    ];
    for (const steps of orders) {
      let result = snapshot;
      for (const ids of steps) result = await load(result, ids);
      const ids = identity(result, 'src/new.ts');
      expect(ids.x).toBe(ids.y);
      expect(ids.u).not.toBe(ids.x);
      expect(result.nodes.filter(node => node.path === 'src/new.ts')).toHaveLength(2);
      expect(new Set(result.nodes.find(node => node.id === ids.u)!.sourceIds)).toEqual(new Set([commitId('u')]));
      expect(result.coverage.reasons.join(' ')).toContain('shared lineage');
    }
    expectOfflineGit(lineage().gitDir);
  });
});
