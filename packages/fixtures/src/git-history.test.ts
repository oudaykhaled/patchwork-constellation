import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitHistoryFixture, HISTORY_GOLDEN, type HistoryChange } from './git-history';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'constellation-authored-history-'));
  directories.push(directory);
  return createGitHistoryFixture(directory);
}
function git(directory: string, args: string[]) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: directory, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function changes(directory: string, base: string, head: string): HistoryChange[] {
  return git(directory, ['diff', '--no-ext-diff', '--name-status', '--find-renames=100%', base, head]).split('\n').filter(Boolean).map((line) => {
    const [status, first, second] = line.split('\t');
    return status === 'R100' ? { status, previousPath: first!, path: second! } : { status: status as HistoryChange['status'], path: first! };
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('independent synthetic Git history', () => {
  it('proves declared root/add/modify/delete/rename/binary/generated/submodule facts using Git', () => {
    const { directory, refs } = fixture();
    expect(git(directory, ['ls-tree', '-r', '--name-only', refs.root]).split('\n')).toEqual(HISTORY_GOLDEN.rootPaths);
    expect(changes(directory, refs.root, refs.featureA)).toEqual(HISTORY_GOLDEN.featureA);
    expect(changes(directory, refs.root, refs.featureB)).toEqual(HISTORY_GOLDEN.featureB);
    expect(git(directory, ['diff', '--numstat', refs.root, refs.featureA, '--', 'assets/logo.bin'])).toBe('-\t-\tassets/logo.bin');
    expect(git(directory, ['ls-tree', refs.root, '--', 'vendor/widget'])).toBe(`160000 commit ${refs.widgetRoot}\tvendor/widget`);
    expect(git(directory, ['ls-tree', refs.featureA, '--', 'vendor/widget'])).toBe(`160000 commit ${refs.widgetUpdate}\tvendor/widget`);
    expect(git(directory, ['remote'])).toBe('');
    expect(git(directory, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(directory, 'src/main.ts'), 'utf8')).toContain("import './missing';");
    expect(HISTORY_GOLDEN.observedImportsAtRoot).toEqual([{ source: 'src/main.ts', target: 'src/shared.ts', specifier: './shared', line: 1 }]);
  });

  it('declares independently based PR unions/overlap and true first-parent merge behavior', () => {
    const { directory, refs } = fixture();
    const a = changes(directory, refs.root, refs.featureA).map((file) => file.path);
    const b = changes(directory, refs.root, refs.featureB).map((file) => file.path);
    expect([...new Set([...a, ...b])].sort()).toEqual(HISTORY_GOLDEN.selectedUnionPaths);
    expect(a.filter((path) => b.includes(path))).toEqual(HISTORY_GOLDEN.overlapPaths);
    expect(git(directory, ['merge-base', refs.featureA, refs.featureB])).toBe(refs.root);
    expect(git(directory, ['rev-parse', `${refs.merge}^1`])).toBe(refs.root);
    expect(git(directory, ['rev-parse', `${refs.merge}^2`])).toBe(refs.featureA);
    expect(changes(directory, `${refs.merge}^1`, refs.merge)).toEqual(HISTORY_GOLDEN.featureA);
    expect(changes(directory, refs.root, refs.featureAFirst)).toEqual([{ status: 'M', path: 'src/shared.ts' }]);
    expect(git(directory, ['show', `${refs.featureAFirst}:src/shared.ts`])).toBe("export const shared = 'alpha-first';");
    expect(git(directory, ['show', `${refs.featureA}:src/shared.ts`])).toBe("export const shared = 'alpha-final';");
  });

  it('regenerates identical commit/tree/diff manifests twice', () => {
    const first = fixture();
    const second = fixture();
    const manifest = (value: ReturnType<typeof fixture>) => JSON.stringify({
      refs: value.refs,
      trees: Object.values(value.refs).map((ref) => git(value.directory, ['ls-tree', '-r', ref])),
      a: changes(value.directory, value.refs.root, value.refs.featureA),
      b: changes(value.directory, value.refs.root, value.refs.featureB),
      golden: value.golden,
    });
    expect(manifest(first)).toBe(manifest(second));
  });

  it('refuses a populated target without deleting caller files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'constellation-fixture-refusal-'));
    directories.push(directory);
    writeFileSync(join(directory, 'keep.txt'), 'keep');
    expect(() => createGitHistoryFixture(directory)).toThrow('requires an empty directory');
    expect(readFileSync(join(directory, 'keep.txt'), 'utf8')).toBe('keep');
  });
});
