import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyzeLocalRepository, loadLocalGitRegistry, type LocalGitRegistry } from '@patchwork/analysis';
import { createGitHistoryFixture } from '../../../packages/fixtures/src/git-history';
import { runSourceAnalysisInWorker } from './index';

// The real worker thread and real Git, except that `git diff-tree` is replaced by a process
// that sleeps. Cancelling the task must stop (and reap) that process, not leave it running.
let root: string, pidFile: string, registry: LocalGitRegistry;
const saved = { PATH: process.env.PATH, LOCAL_REPOS: process.env.LOCAL_REPOS, LOCAL_REPOS_ONLY: process.env.LOCAL_REPOS_ONLY };
const started: number[] = [];
/** True while the process exists, including as an unreaped zombie. */
const exists = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'patchwork-worker-cancel-'));
  const fixture = createGitHistoryFixture(join(root, 'work'));
  const mirror = join(root, 'fixture.git');
  execFileSync('git', ['clone', '--quiet', '--mirror', '--no-hardlinks', fixture.directory, mirror], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = join(root, 'bin'); mkdirSync(bin); pidFile = join(root, 'diff-tree.pid');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = diff-tree ]; then echo $$ > '${pidFile}'; exec sleep 30; fi\ndone\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  writeFileSync(join(root, 'registry.json'), JSON.stringify({ version: 1, repositories: [{ id: 'local/fixture', label: 'Fixture', gitDir: mirror, defaultRef: 'main' }] }));
  process.env.PATH = `${bin}:${process.env.PATH}`; process.env.LOCAL_REPOS = join(root, 'registry.json'); process.env.LOCAL_REPOS_ONLY = 'true';
  registry = (await loadLocalGitRegistry())!;
});
afterAll(() => {
  // Only the process this test started, and only if the code under test left it behind.
  for (const pid of started) if (exists(pid)) process.kill(pid, 'SIGKILL');
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('cancelling a local task', () => {
  it('stops and reaps the Git process it was waiting on', { timeout: 30_000 }, async () => {
    const repository = registry.get('local/fixture')!;
    const snapshot = await analyzeLocalRepository({ repository: 'local/fixture' }, repository);
    const merge = snapshot.sources.find(source => source.kind === 'commit' && source.mergeCommit)!;
    const controller = new AbortController();
    const work = runSourceAnalysisInWorker(snapshot, 'commit', [merge.id], { signal: controller.signal });
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    let pid = 0;
    await vi.waitFor(() => { if (existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8').trim()); expect(pid).toBeGreaterThan(1); }, { timeout: 15_000, interval: 50 });
    started.push(pid);
    expect(exists(pid)).toBe(true);
    controller.abort();
    await rejected;
    // Gone from the process table: killed by the thread and reaped, not orphaned or a zombie.
    await vi.waitFor(() => expect(exists(pid)).toBe(false), { timeout: 3_000, interval: 50 });
  });
});
