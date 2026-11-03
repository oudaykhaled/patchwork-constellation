import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerGroupingStoragePath, readGroupingHistory, writeGroupingHistory } from './history';

const directories: string[] = [];
const localPath = () => { const path = mkdtempSync(join(tmpdir(), 'constellation-revisions-')); directories.push(path); return join(path, 'history.json'); };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('atomic grouping history', () => {
  it('compares generations and leaves the winning durable file unchanged', () => {
    const path = localPath();
    expect(readGroupingHistory(path).generation).toBe(0);
    expect(writeGroupingHistory(path, 0, [])).toBe(1);
    const first = readFileSync(path, 'utf8');
    expect(() => writeGroupingHistory(path, 0, [])).toThrow('changed in another process');
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(writeGroupingHistory(path, 1, [])).toBe(2);
  });
  it('fails closed when another process holds the lock and permits retry after release', () => {
    const path = localPath(); writeFileSync(`${path}.lock`, 'test-owned lock');
    expect(() => writeGroupingHistory(path, 0, [])).toThrow('Another process');
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe('test-owned lock');
    rmSync(`${path}.lock`);
    expect(writeGroupingHistory(path, 0, [])).toBe(1);
  });
  it('does not silently replace malformed or oversize history', () => {
    const path = localPath(); writeFileSync(path, '{"version":2,"generation":1,"histories":"invalid"}');
    const before = readFileSync(path, 'utf8');
    expect(() => readGroupingHistory(path)).toThrow('invalid');
    expect(() => writeGroupingHistory(path, 0, [])).toThrow('invalid');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it('uses non-reversible owner suffixes and preserves the local-public path', () => {
    expect(ownerGroupingStoragePath(undefined, 'alice')).toBeUndefined();
    expect(ownerGroupingStoragePath('state/history.json', 'local-public')).toBe('state/history.json');
    const left = ownerGroupingStoragePath('state/history.json', 'alice')!;
    const right = ownerGroupingStoragePath('state/history.json', 'bob')!;
    expect(left).not.toEqual(right); expect(left).not.toContain('alice');
    expect(ownerGroupingStoragePath('state/history.json', 'alice')).toBe(left);
  });
});
