import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const suite = process.argv[2] || 'check';
if (!['check', 'browser'].includes(suite)) throw new Error('Unknown check suite');
const commands = suite === 'browser' ? ['test:e2e'] : ['format:check', 'lint', 'test:quality', 'typecheck', 'test', 'build'];
const results = [];
let exitCode = 0;
for (const command of commands) {
  const started = performance.now();
  const cli = process.env.npm_execpath;
  const result = cli
    ? spawnSync(process.execPath, [cli, command], { stdio: 'inherit' })
    : spawnSync('pnpm', [command], { stdio: 'inherit', shell: process.platform === 'win32' });
  exitCode = result.status ?? 1;
  results.push({ check: command, exitCode, durationMs: Math.round(performance.now() - started) });
  if (exitCode) break;
}
// Diagnostic artifacts contain only bounded allowlisted metadata, never stdout,
// environment, URLs, paths, test payloads, screenshots, source or provider prompts.
mkdirSync('.ci-diagnostics', { recursive: true });
writeFileSync(`.ci-diagnostics/${suite}.json`, JSON.stringify({ schemaVersion: 1, suite, success: !exitCode, results }, null, 2) + '\n');
process.exitCode = exitCode;
