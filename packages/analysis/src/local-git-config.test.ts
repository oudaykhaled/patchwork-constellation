import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalConfigError, loadLocalGitConfig, loadLocalGitRegistry, currentLocalGitRegistry, localGitOnly, normalizeFootprints, publicLocalConfig, LOCAL_LIMIT_DEFAULTS } from './local-git-config';

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
let root: string, mirror: string, worktree: string;
const write = (name: string, value: unknown) => { const path = join(root, name); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; };
const repo = (extra: Record<string, unknown> = {}) => ({ id: 'local/sample', label: 'Sample', gitDir: mirror, defaultRef: 'main', ...extra });
async function problems(config: unknown): Promise<string[]> {
  try { await loadLocalGitConfig(write(`config-${Math.random().toString(36).slice(2)}.json`, config)); }
  catch (error) { expect(error).toBeInstanceOf(LocalConfigError); return (error as LocalConfigError).problems; }
  throw new Error('expected a configuration problem');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'patchwork-local-config-'));
  worktree = join(root, 'work'); mkdirSync(worktree);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', '.'], { cwd: worktree, env });
  writeFileSync(join(worktree, 'a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: worktree, env });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'root'], { cwd: worktree, env });
  mirror = join(root, 'sample.git');
  execFileSync('git', ['clone', '--quiet', '--mirror', '--no-hardlinks', worktree, mirror], { env });
  mkdirSync(join(root, 'not-git'));
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('local repository registry', () => {
  it('loads a valid file, resolves relative paths and applies bounded limits', async () => {
    write('mapping.json', { version: 1, modules: [{ id: 'feature-a', label: 'Feature A', paths: ['src'] }] });
    write('prints.json', { schemaVersion: 1, pulls: [{ number: 7, title: 'Seven', files: [{ path: 'a.ts', status: 'modified' }] }] });
    const registry = await loadLocalGitConfig(write('sample-registry.json', { version: 1, limits: { maxFiles: 5_000 }, repositories: [repo({ gitDir: './sample.git', mapping: 'mapping.json', footprints: 'prints.json', exclude: ['**/*.png'], limits: { maxSourceFiles: 40 } })] }), { only: true });
    const entry = registry.get('LOCAL/Sample')!;
    expect(entry).toMatchObject({ fullName: 'local/sample', label: 'Sample', defaultRef: 'main', exclude: ['**/*.png'], limits: { ...LOCAL_LIMIT_DEFAULTS, maxFiles: 5_000, maxSourceFiles: 40 } });
    expect(entry.footprints!.records.map(record => record.key)).toEqual(['pr:7']);
    expect(entry.mapping).toMatchObject({ modules: [{ id: 'feature-a' }] });
    expect(registry.get('octocat/hello-world')).toBeUndefined();
    expect(registry.get('https://evil.test/x')).toBeUndefined();
    const visible = JSON.stringify(publicLocalConfig(registry));
    expect(visible).not.toContain(root);
    expect(JSON.parse(visible)).toMatchObject({ enabled: true, only: true, repositories: [{ fullName: 'local/sample', label: 'Sample', defaultRef: 'main' }] });
    expect(publicLocalConfig(undefined)).toEqual({ enabled: false, only: false, repositories: [] });
  });
  it('rejects unsafe or broken entries without printing any path', async () => {
    const cases: [unknown, RegExp][] = [
      [{ version: 1, repositories: [repo({ id: 'not a repo' })] }, /owner\/name/],
      [{ version: 1, repositories: [repo({ gitDir: join(root, 'missing.git') })] }, /local\/sample: gitDir is not a readable Git directory/],
      [{ version: 1, repositories: [repo({ gitDir: join(root, 'not-git') })] }, /gitDir is not a readable Git directory/],
      [{ version: 1, repositories: [repo({ gitDir: join(worktree, '.git') })] }, /must be a bare mirror/],
      [{ version: 1, repositories: [repo({ defaultRef: 'no-such-branch' })] }, /defaultRef no-such-branch does not resolve/],
      [{ version: 1, repositories: [repo({ defaultRef: '--upload-pack=x' })] }, /entry 1 is invalid \(defaultRef\)/],
      [{ version: 1, repositories: [repo(), repo()] }, /listed twice/],
      [{ version: 1, repositories: [repo({ mapping: write('bad-mapping.json', { version: 2 }) })] }, /mapping file is unreadable or is not a valid/],
      [{ version: 1, repositories: [repo({ footprints: write('bad-prints.json', '{') })] }, /footprint file is unreadable/],
      [{ version: 1, repositories: [repo({ exclude: ['../outside'] })] }, /entry 1 is invalid \(exclude/],
      [{ version: 1, repositories: [repo({ token: 'x' })] }, /entry 1 is invalid/],
      [{ version: 1, repositories: [{ label: 'No id', gitDir: mirror, defaultRef: 'main' }] }, /entry 1 is invalid \(id\)/],
    ];
    for (const [config, expected] of cases) {
      const found = await problems(config);
      expect(found.join(' ')).toMatch(expected);
      expect(found.join(' ')).not.toContain(root);
    }
    for (const limits of [{ maxFiles: 25_001 }, { maxSnapshotBytes: 64 * 1_048_576 + 1 }, { workerHeapMb: 4_096 }, { maxSourceFiles: 501 }, { unknown: 1 }]) expect((await problems({ version: 1, limits, repositories: [repo()] })).join(' ')).toMatch(/file is invalid \(limits/);
    expect(await problems({ version: 2, repositories: [repo()] })).toEqual([expect.stringMatching(/invalid \(version\)/)]);
    await expect(loadLocalGitConfig('relative.json')).rejects.toBeInstanceOf(LocalConfigError);
    await expect(loadLocalGitConfig(join(root, 'absent.json'))).rejects.toThrow(/unreadable/);
  });
  it('is local-only unless explicitly opened, and memoizes the process registry', async () => {
    expect(localGitOnly({})).toBe(true);
    expect(localGitOnly({ LOCAL_REPOS_ONLY: 'false' })).toBe(false);
    expect(await loadLocalGitRegistry({})).toBeUndefined();
    const path = write('process.json', { version: 1, repositories: [repo()] });
    const environment = { LOCAL_REPOS: path };
    expect(currentLocalGitRegistry(environment)).toBeUndefined();
    const first = await loadLocalGitRegistry(environment);
    expect(await loadLocalGitRegistry(environment)).toBe(first);
    expect(currentLocalGitRegistry(environment)).toBe(first);
    expect(first!.only).toBe(true);
  });
});

describe('footprint normalization', () => {
  const sha = 'a'.repeat(40), other = 'b'.repeat(40);
  it('reads views, merges duplicates across views and keeps each recorded file status', () => {
    const result = normalizeFootprints({ schemaVersion: 1, views: [
      { id: 'review-a', title: 'Review A', description: 'Example set', sources: [
        { kind: 'pr', number: 101, title: 'Add feature A', updatedAt: '2026-01-01T00:00:00.123456Z', headSha: sha, notes: ['example note', '', 3], files: [{ path: 'src/feature-a/a.ts', status: 'added' }, { path: 'src/feature-a/b.ts', status: 'modified', inHead: false }, { path: 'src/feature-a/c.ts', status: 'renamed', previousPath: 'src/old/c.ts' }, { path: 'src/feature-a/d.ts', status: 'R100' }, { path: '../evil', status: 'added' }] },
        { kind: 'commit', sha: other, title: 'Update feature B', files: [{ path: 'src/feature-b/x.ts', status: 'A' }] },
      ] },
      { id: 'review-b', title: 'Review B', sources: [{ kind: 'pr', number: 101, title: 'Add feature A again', files: [] }, { kind: 'pr', number: 'not-a-number', files: [] }] },
    ] });
    expect(result.records.map(record => record.key)).toEqual(['pr:101', `commit:${other}`]);
    const pr = result.records[0]!;
    expect(pr).toMatchObject({ number: 101, title: 'Add feature A', headSha: sha, updatedAt: '2026-01-01T00:00:00.123Z', views: ['review-a', 'review-b'], notes: ['example note'] });
    expect(pr.files).toEqual([{ path: 'src/feature-a/a.ts', status: 'added', deletions: 0 }, { path: 'src/feature-a/b.ts', status: 'modified', inHead: false }, { path: 'src/feature-a/c.ts', status: 'renamed', previousPath: 'src/old/c.ts' }, { path: 'src/feature-a/d.ts', status: 'modified' }]);
    expect(result.records[1]).toMatchObject({ kind: 'commit', sha: other, files: [{ path: 'src/feature-b/x.ts', status: 'added', deletions: 0 }] });
    expect(result.views).toEqual([{ id: 'review-a', title: 'Review A', description: 'Example set', kind: 'mixed', sourceIds: ['pr:101', `commit:${other}`], omitted: 0 }, { id: 'review-b', title: 'Review B', kind: 'pr', sourceIds: ['pr:101'], omitted: 0 }]);
    expect(result.problems).toEqual(['1 footprint records were invalid and are not listed.', '1 footprint file rows were invalid, duplicated or over the per-record limit and are not shown.']);
  });
  it('lets a view reference a pull or commit listed in the same file', () => {
    const result = normalizeFootprints({ pulls: [{ number: 7, title: 'Seven', files: [{ path: 'src/feature-a/a.ts', status: 'modified' }] }], commits: [{ sha, title: 'Commit A' }], views: [{ id: 'review-a', sources: [{ kind: 'pr', number: 7 }, { kind: 'commit', sha }] }] });
    expect(result.records.map(record => [record.key, record.title, record.views])).toEqual([['pr:7', 'Seven', ['review-a']], [`commit:${sha}`, 'Commit A', ['review-a']]]);
    expect(result.records[0]!.files).toEqual([{ path: 'src/feature-a/a.ts', status: 'modified' }]);
    expect(result.views).toEqual([{ id: 'review-a', title: 'review-a', kind: 'mixed', sourceIds: ['pr:7', `commit:${sha}`], omitted: 0 }]);
  });
  it('filters multi-repository files by repo name, with a trailing wildcard', () => {
    const input = { commits: [{ sha, repo: 'web@feature/x', files: [] }, { sha: other, repo: 'api', files: [] }] };
    expect(normalizeFootprints(input, ['web*']).records.map(record => record.sha)).toEqual([sha]);
    expect(normalizeFootprints(input, ['api']).records.map(record => record.sha)).toEqual([other]);
    expect(normalizeFootprints(input, ['nothing']).problems).toEqual(['No footprint records matched this repository.']);
    expect(normalizeFootprints({ pulls: [{ number: 1 }, { number: 2 }, { number: 3 }] }, undefined, 2).problems).toEqual(['1 footprint records exceed the listing limit of 2 and are not listed.']);
    expect(normalizeFootprints({ commits: [{ id: sha }] }).problems).toEqual(['1 footprint records were invalid and are not listed.']);
    // A view source without its own repo references the kept record; one naming another repo is filtered.
    const shared = normalizeFootprints({ pulls: [{ number: 7, repo: 'web', files: [] }, { number: 8, repo: 'api', files: [] }], views: [{ id: 'review-a', sources: [{ kind: 'pr', number: 7 }, { kind: 'pr', number: 7, repo: 'api' }, { kind: 'pr', number: 8 }] }] }, ['web']);
    expect(shared.records.map(record => [record.key, record.views])).toEqual([['pr:7', ['review-a']]]);
    expect(shared.views).toEqual([{ id: 'review-a', title: 'review-a', kind: 'pr', sourceIds: ['pr:7'], omitted: 0 }]);
    expect(() => normalizeFootprints({ other: [] })).toThrow();
  });
  it('keeps at most the repository maxChangedFiles rows per recorded footprint', async () => {
    const files = Array.from({ length: 5 }, (_, index) => ({ path: `src/feature-a/f${index}.ts`, status: 'modified' }));
    const direct = normalizeFootprints({ pulls: [{ number: 7, files }] }, undefined, 10, 2);
    expect(direct.records[0]!.files!.map(file => file.path)).toEqual(['src/feature-a/f0.ts', 'src/feature-a/f1.ts']);
    expect(direct.problems).toContain('1 footprint records list more than 2 files (maxChangedFiles); only their first 2 rows are shown.');
    // Through the registry: the configured limit applies, not the 50,000 ceiling.
    write('wide-prints.json', { schemaVersion: 1, pulls: [{ number: 7, files }] });
    const registry = await loadLocalGitConfig(write('wide-registry.json', { version: 1, repositories: [repo({ footprints: 'wide-prints.json', limits: { maxChangedFiles: 3 } })] }));
    const entry = registry.get('local/sample')!;
    expect(entry.footprints!.records[0]!.files).toHaveLength(3);
    expect(entry.footprints!.problems).toContain('1 footprint records list more than 3 files (maxChangedFiles); only their first 3 rows are shown.');
  });
});
