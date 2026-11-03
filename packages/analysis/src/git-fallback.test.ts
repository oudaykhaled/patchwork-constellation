import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { boundedGitDiff, EMPTY_GIT_TREE, parseGitDiff } from './git-fallback';

const exec = promisify(execFile);
describe('bounded bare Git diff evidence', () => {
  it('parses binary and rename NUL records without losing tabs/newlines', () => {
    const files = parseGitDiff(Buffer.from('R100\0old\tname.ts\0new\nname.ts\0A\0binary.dat\0'), Buffer.from('0\t0\t\0old\tname.ts\0new\nname.ts\0-\t-\tbinary.dat\0'));
    expect(files).toEqual([{ filename: 'new\nname.ts', previous_filename: 'old\tname.ts', status: 'renamed', additions: 0, deletions: 0, binary: false }, { filename: 'binary.dat', status: 'added', additions: 0, deletions: 0, binary: true }]);
  });
  it('rejects unsafe paths, malformed/incomplete stats, invalid UTF-8 and file-budget overflow', () => {
    expect(() => parseGitDiff(Buffer.from('A\0../secret\0'), Buffer.from('1\t0\t../secret\0'))).toThrow();
    expect(() => parseGitDiff(Buffer.from('A\0a.ts\0'), Buffer.from(''))).toThrow();
    expect(() => parseGitDiff(Buffer.from('A\0a.ts\0'), Buffer.from('NaN\t0\ta.ts\0'))).toThrow();
    expect(() => parseGitDiff(Buffer.from([65, 0, 255, 0]), Buffer.from(''))).toThrow();
    expect(() => parseGitDiff(Buffer.from('A\0a.ts\0'), Buffer.from('1\t0\ta.ts\0'), 0)).toThrow();
  });
  it('rejects unpinned objects/arbitrary destinations and stops before spawning when canceled', async () => {
    await expect(boundedGitDiff({ repository: 'https://evil.test/acme/tool', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
    await expect(boundedGitDiff({ repository: 'acme/tool', baseSha: '--upload-pack=evil', headSha: 'b'.repeat(40) })).rejects.toMatchObject({ code: 'INVALID_REF' });
    const controller = new AbortController(); controller.abort();
    await expect(boundedGitDiff({ repository: 'acme/tool', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), signal: controller.signal })).rejects.toThrow();
  });
  it('matches hand-authored root/edit/revert/rename/delete/merge Git history goldens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'patchwork-golden-'));
    const git = async (...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 'Synthetic Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }, encoding: 'buffer' })).stdout;
    const commit = async (message: string) => { await git('add', '-A'); await git('commit', '-m', message); return (await git('rev-parse', 'HEAD')).toString().trim(); };
    const diff = async (base: string, head: string) => parseGitDiff(await git('diff', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '-z', '--name-status', base, head, '--'), await git('diff', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '-z', '--numstat', base, head, '--'));
    try {
      await git('init', '--template=', '--initial-branch=main');
      await writeFile(join(directory, 'old.ts'), 'export const value = 1;\n'); const root = await commit('root');
      await writeFile(join(directory, 'old.ts'), 'export const value = 2;\n'); const edit = await commit('edit');
      await writeFile(join(directory, 'old.ts'), 'export const value = 1;\n'); const revert = await commit('revert');
      await rename(join(directory, 'old.ts'), join(directory, 'renamed.ts')); const renamed = await commit('rename');
      await git('checkout', '-b', 'feature'); await writeFile(join(directory, 'feature.ts'), 'export const feature = true;\n'); await commit('feature');
      await git('checkout', 'main'); await writeFile(join(directory, 'main.ts'), 'export const main = true;\n'); const firstParent = await commit('main');
      await git('merge', '--no-ff', '--no-edit', 'feature'); const merged = (await git('rev-parse', 'HEAD')).toString().trim();
      await rm(join(directory, 'renamed.ts')); const deleted = await commit('delete');
      expect((await diff(EMPTY_GIT_TREE, root)).map(file => [file.filename, file.status, file.additions, file.deletions])).toEqual([['old.ts', 'added', 1, 0]]);
      expect((await diff(root, edit)).map(file => [file.filename, file.additions, file.deletions])).toEqual([['old.ts', 1, 1]]);
      expect((await diff(edit, revert)).map(file => file.filename)).toEqual(['old.ts']);
      expect(await diff(root, revert)).toEqual([]); // activity union still has one touched file across the two deltas.
      expect((await diff(revert, renamed))[0]).toMatchObject({ filename: 'renamed.ts', previous_filename: 'old.ts', status: 'renamed', additions: 0, deletions: 0 });
      expect((await diff(firstParent, merged)).map(file => file.filename)).toEqual(['feature.ts']);
      expect((await diff(merged, deleted))[0]).toMatchObject({ filename: 'renamed.ts', status: 'removed', additions: 0, deletions: 1 });
    } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
  });
});
