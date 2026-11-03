import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { analyzeRepository, loadSourceChanges } from '@patchwork/analysis';
import { createSelectionFootprint } from '@patchwork/contracts';
import { createScaleFixture } from '@patchwork/fixtures';
import { createStore } from '@patchwork/storage';
import { createApplicationServer } from '../../apps/web/server';
import { gitCorpus } from './git-corpus';

const output = process.argv[2] ?? 'docs/evidence/data-09.json';
const directory = await mkdtemp(join(tmpdir(), 'constellation-release-'));
const cleanDirectory = resolve(directory);
if (dirname(cleanDirectory).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(cleanDirectory).startsWith('constellation-release-')) throw new Error('Temporary corpus is outside its named root');
const phases: { stage: string; progress: number; elapsedMs: number }[] = [];
let analysis: unknown;
try {
  const fixture = gitCorpus(directory), start = performance.now();
  const graph = await analyzeRepository({ repository: 'fixture/corpus' }, { fetch: fixture.fetch, onProgress: item => phases.push({ stage: item.stage, progress: item.progress, elapsedMs: Number((performance.now() - start).toFixed(2)) }) });
  const analyzedMs = performance.now() - start, sourceStart = performance.now();
  const selected = await loadSourceChanges(graph, 'pr', ['pr:1', 'pr:2'], { fetch: fixture.fetch });
  const counts = createSelectionFootprint(selected, ['pr:1', 'pr:2']).counts;
  if (counts.changedFiles !== 8 || counts.overlappingFiles !== 1) throw new Error('Unexplained Git golden file-count discrepancy');
  analysis = { fixture: 'authored real Git history behind controlled GitHub transport', inventory: graph.nodes.length, edges: graph.edges.length, counts, coverage: graph.coverage.status, phases, totalAnalysisMs: Number(analyzedMs.toFixed(2)), sourceOverlayMs: Number((performance.now() - sourceStart).toFixed(2)), network: 'no external traffic; actual local Git object reads inside fixture transport' };
} finally { await rm(cleanDirectory, { recursive: true, force: true, maxRetries: 3 }); }

const scale = createScaleFixture(10_000, 40_000, 42), store = await createStore({ databaseUrl: '', maxSnapshots: 4 });
await store.putSnapshot({ ownerId: 'local-public', repository: scale.repository.fullName }, scale);
const server = await createApplicationServer({ production: true, store });
await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
let progressive: unknown;
try {
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, repo = `repository=${encodeURIComponent(scale.repository.fullName)}`;
  const start = performance.now(), metadataResponse = await fetch(`${origin}/api/graphs/${scale.id}?${repo}`), metadata = await metadataResponse.json();
  const metadataMs = performance.now() - start;
  if (metadataResponse.status !== 200 || metadata.counts.files !== 10_000 || metadata.counts.edges !== 40_000) throw new Error('10k metadata count mismatch');
  const results = [];
  for (const kind of ['nodes', 'edges']) {
    const timings: number[] = []; let cursor: string | null = null, count = 0, bytes = 0, maxBytes = 0;
    do {
      const before = performance.now(), params = new URLSearchParams({ repository: scale.repository.fullName, kind, version: metadata.version, limit: kind === 'nodes' ? '500' : '1000', ...(cursor ? { cursor } : {}) });
      const response = await fetch(`${origin}/api/graphs/${scale.id}/chunks?${params}`), text = await response.text();
      if (response.status !== 200) throw new Error('Progressive HTTP error');
      const size = Buffer.byteLength(text); if (size >= 512_000) throw new Error('Progressive response budget exceeded');
      const page = JSON.parse(text); timings.push(performance.now() - before); count += page.items.length; bytes += size; maxBytes = Math.max(maxBytes, size); cursor = page.nextCursor;
      if (timings.length > 100) throw new Error('Paging exceeded finite graph budget');
    } while (cursor);
    if (count !== (kind === 'nodes' ? 10_000 : 40_000)) throw new Error('Progressive graph item count discrepancy');
    const sorted = [...timings].sort((a, b) => a - b);
    results.push({ kind, count, pages: timings.length, bytes, maxBytes, totalMs: Number(timings.reduce((sum, value) => sum + value, 0).toFixed(2)), p95PageMs: Number(sorted[Math.ceil(sorted.length * .95) - 1]!.toFixed(2)) });
  }
  progressive = { fixture: '10k files / 40k authored synthetic edges', seed: 42, state: 'cold in-process memory store recovery; sequential loopback HTTP pages, no browser', metadataMs: Number(metadataMs.toFixed(2)), metadataBytes: Buffer.byteLength(JSON.stringify(metadata)), results };
} finally { await new Promise<void>((ready, reject) => server.close(error => error ? reject(error) : ready())); }

const report = {
  schemaVersion: '1', status: 'partial', measuredAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  conditions: { platform: platform(), osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), runtime: process.version, database: 'memory', concurrency: process.env.BACKEND_RELEASE_ACTIVITY || 'Concurrent activity was not recorded; do not treat this sample as reference-runner certification.', externalServices: 'all GitHub responses controlled; no external GitHub, models or webhook delivery' },
  checks: [
    { id: 'authored-git-pr-counts', status: 'passed', evidence: '8 directly touched files / 1 overlapping file; real Git histories, hand-declared expected sets' },
    { id: 'progressive-10k-http', status: 'passed', evidence: '10,000 nodes and 40,000 edges across bounded pages; complete item counts' },
    { id: 'retention-input-isolation', status: 'partial', evidence: 'This measurement command does not execute the separate test suite. Run pnpm exec vitest run tests/backend-release and retain its result alongside this report; cases are documented in docs/issues/28.md.' },
    { id: 'postgres-staging-isolation', status: 'partial', evidence: 'No staging PostgreSQL/App registration/live removal or account disconnect was available in this worktree' },
    { id: 'process-containment', status: 'partial', evidence: 'Git fallback process/bytes/disk/time bounded; kernel CPU/memory sandbox and adversarial staging capacity not established' },
  ], analysis, progressive,
  limitations: ['One sample does not establish production capacity or latency percentiles across users.', 'Synthetic edge evidence is authored fixture data, never claimed to be observed source dependencies.', 'No archive extractor exists. Unsafe Git paths are denied; this does not validate a future archive ingestion path.', 'Human and live multi-user staging acceptance remain required before beta.'],
};
await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, status: report.status, analysis, progressive }, null, 2));
