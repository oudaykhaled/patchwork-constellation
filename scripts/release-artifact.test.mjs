import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { safeReleasePath, verifyRelease, createRelease, extractReleaseArchive, inspectReleaseArchive } from './release-artifact.mjs';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { releaseGate } from './release-gate.mjs';
test('release paths reject traversal, credentials and symlink container directories', () => {
  for (const path of ['../escape', '/absolute', 'apps/../secret', '.env', 'apps/.env.local', 'secret.pem', 'node_modules/runtime', 'C:/escape', 'file:stream', 'NUL.txt', 'folder/ends.']) assert.throws(() => safeReleasePath(path));
  assert.equal(safeReleasePath('.env.example'), '.env.example'); assert.equal(safeReleasePath('dist/assets/app.js'), 'dist/assets/app.js');
});
test('production cannot promote missing or mismatched release evidence', () => {
  const commit = 'a'.repeat(40); const evidence = Object.fromEntries(['browser', 'accessibility', 'performance', 'backend', 'security', 'deployment', 'databaseRestore', 'rollback'].map(name => [name, { status: 'passed', reference: 'synthetic test evidence', commit }]));
  const manifest = { schemaVersion: '1', stage: 'production', intelligence: 'disabled', license: 'Apache-2.0', hosting: 'test fixture', reviewedBy: 'test maintainer', commit, evidence };
  assert.equal(releaseGate(manifest, commit).intelligence, 'disabled'); assert.throws(() => releaseGate(manifest, 'b'.repeat(40))); assert.throws(() => releaseGate({ ...manifest, evidence: { ...evidence, databaseRestore: { status: 'not-run' } } }, commit)); assert.throws(() => releaseGate({ ...manifest, intelligence: 'enabled' }, commit));
});
test('manifest verification detects changed payloads and duplicate paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'constellation-artifact-test-'));
  try { const content = Buffer.from('safe'); await mkdir(join(dir, 'dist')); await writeFile(join(dir, 'dist/index.html'), content); const manifest = { schemaVersion: '1', id: 'test', files: [{ path: 'dist/index.html', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }] }; await writeFile(join(dir, 'release-manifest.json'), JSON.stringify(manifest)); assert.equal((await verifyRelease(dir)).files, 1); await writeFile(join(dir, 'dist/index.html'), 'changed'); await assert.rejects(verifyRelease(dir)); } finally { if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup target'); await rm(dir, { recursive: true, force: true }); }
});
test('committed releases reproduce byte-for-byte, extract safely and reject corruption', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'constellation-release-golden-'));
  try {
    const git = args => execFileSync('git', args, { cwd: dir, windowsHide: true, stdio: 'ignore' });
    await mkdir(join(dir, 'dist')); await writeFile(join(dir, '.gitignore'), 'dist/\nrelease-artifacts/\n'); await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', license: 'Apache-2.0', engines: { node: '>=24 <25' }, packageManager: 'pnpm@11.25.0' })); await writeFile(join(dir, 'LICENSE'), 'Apache-2.0 test fixture'); await writeFile(join(dir, 'dist/index.html'), '<div id="root"></div>');
    git(['init']); git(['add', '.']); git(['-c', 'user.name=Codex', '-c', 'user.email=codex@openai.com', 'commit', '-m', 'synthetic release fixture']);
    const first = await createRelease(dir); const firstBytes = await readFile(first.archive); const second = await createRelease(dir); assert.equal(first.sha256, second.sha256); assert.deepEqual(firstBytes, await readFile(second.archive));
    const target = join(dir, 'release-artifacts/extracted'); const verified = await extractReleaseArchive(firstBytes, target); assert.equal(verified.commit, first.commit); assert.equal(verified.mode, 'deterministic-preview'); assert.throws(() => inspectReleaseArchive(Buffer.from('invalid gzip')));
    await writeFile(join(dir, 'LICENSE'), 'changed'); await assert.rejects(createRelease(dir));
  } finally { if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup target'); await rm(dir, { recursive: true, force: true }); }
});
