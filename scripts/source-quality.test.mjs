import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { formatSource, lintSource } from './source-quality.mjs';

test('formatting normalizes whitespace without discarding Markdown hard breaks', () => {
  assert.equal(formatSource('const a = 1;  \r\n\r\n'), 'const a = 1;\n');
  assert.equal(formatSource('hard break  \n', true), 'hard break  \n');
});

test('lint identifies executable dangerous/debug/focused code, not text in strings', () => {
  assert.deepEqual(lintSource('safe.ts', 'const label = "eval(hello); debugger;";'), []);
  assert.deepEqual(lintSource('bad.ts', 'debugger; eval("x"); new Function("x"); test.describe.only("x", () => {});').map(value => value.rule), ['no-debugger', 'no-eval', 'no-new-function', 'no-focused-tests']);
});

test('a deliberate bad fixture exits nonzero, and corrected fixture exits zero', () => {
  const directory = mkdtempSync(join(tmpdir(), 'constellation-check-failure-'));
  try {
    const fixture = join(directory, 'fixture.ts');
    writeFileSync(fixture, 'debugger;\n');
    const failed = spawnSync(process.execPath, ['scripts/source-quality.mjs', fixture], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /no-debugger/);
    writeFileSync(fixture, 'export const safe = true;\n');
    assert.equal(spawnSync(process.execPath, ['scripts/source-quality.mjs', fixture]).status, 0);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
