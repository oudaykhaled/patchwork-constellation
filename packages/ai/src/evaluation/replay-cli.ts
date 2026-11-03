import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { replayLiveEvaluation } from './live-report';

const args = process.argv.slice(2);
if (args.some(value => !/^--(?:input|repeat|output)=.+$/.test(value)) || args.filter(value => value.startsWith('--input=')).length !== 1 || args.filter(value => value.startsWith('--repeat=')).length > 1 || args.filter(value => value.startsWith('--output=')).length > 1) throw new Error('Use --input=<capture.json> [--repeat=<capture.json>] [--output=<report.json>]. This command is offline and never enables AI.');
async function readCapture(path: string) {
  if ((await stat(path)).size > 1_000_000) throw new Error('Capture exceeds the one-megabyte input limit.');
  const bytes = await readFile(path);
  if (bytes.length > 1_000_000) throw new Error('Capture exceeds the one-megabyte input limit.');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
const input = args.find(value => value.startsWith('--input='))!.slice('--input='.length);
const repeat = args.find(value => value.startsWith('--repeat='))?.slice('--repeat='.length);
const report = replayLiveEvaluation(await readCapture(input), repeat ? await readCapture(repeat) : undefined);
const destination = resolve(args.find(value => value.startsWith('--output='))?.slice('--output='.length) ?? '.tmp/live-evaluation-replayed.json');
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(JSON.stringify({ kind: report.kind, status: report.status, holdoutFiles: report.stages.jevGated.count, stability: report.stability }) + '\n');
