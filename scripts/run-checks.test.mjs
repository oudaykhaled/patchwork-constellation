import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

test('the check runner stops on failure and artifacts exclude raw output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'constellation-check-runner-'));
  try {
    const cli = join(directory, 'pnpm-fixture.cjs');
    writeFileSync(cli, 'console.error("PRIVATE_FIXTURE_SHOULD_NOT_BE_UPLOADED"); process.exit(process.argv[2] === "lint" ? 1 : 0);\n');
    const result = spawnSync(process.execPath, [resolve('scripts/run-checks.mjs'), 'check'], {
      cwd: directory, env: { ...process.env, npm_execpath: cli }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    const summary = readFileSync(join(directory, '.ci-diagnostics/check.json'), 'utf8');
    const report = JSON.parse(summary);
    assert.equal(report.success, false);
    assert.deepEqual(report.results.map(step => step.check), ['format:check', 'lint']);
    assert.deepEqual(report.results.map(step => step.exitCode), [0, 1]);
    assert.ok(summary.length < 2048);
    assert.ok(!summary.includes('PRIVATE_FIXTURE'));
    assert.ok(!summary.includes(directory));
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PR workflow retains read-only isolated checks and full action pins', () => {
  const workflow = readFileSync('.github/workflows/checks.yml', 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run|secrets\.|id-token: write|contents: write/);
  assert.doesNotMatch(workflow, /playwright-report\/|test-results\//);
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 2);
  for (const line of workflow.split('\n').filter(line => line.includes('uses:'))) assert.match(line, /uses: [\w/-]+@[a-f0-9]{40} # v\d/);
});
