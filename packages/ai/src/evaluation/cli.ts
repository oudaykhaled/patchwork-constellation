import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runDeterministicEvaluation } from './runner';

const args = process.argv.slice(2);
const destination = args.find(value => value.startsWith('--output='))?.slice('--output='.length) ?? 'docs/evaluation/results.json';
if (args.some(value => !value.startsWith('--output='))) throw new Error('Supported invocation: pnpm exec tsx packages/ai/src/evaluation/cli.ts --output=docs/evaluation/results.json. This command never calls live providers.');
const report = await runDeterministicEvaluation();
const target = resolve(destination);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
const safetyPassed = Object.values(report.hardGates).every(Boolean) && report.stability === 1;
process.stdout.write(JSON.stringify({ kind: report.kind, status: report.status, safetyPassed, holdoutCases: report.corpus.holdoutCases, releaseBlockers: report.releaseBlockers.length }) + '\n');
if (!safetyPassed) process.exitCode = 1;
