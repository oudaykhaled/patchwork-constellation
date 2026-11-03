import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createScaleFixture } from '@patchwork/fixtures';
import { graphChunk, graphMetadata } from './graph-api';

const fixtures = [1_000, 10_000].map(files => {
  const snapshot = createScaleFixture(files, files * 4, 42), startHeap = process.memoryUsage().heapUsed;
  const start = performance.now(), metadata = graphMetadata(snapshot), metadataMs = performance.now() - start;
  const kinds = ['nodes', 'edges'].map(kind => {
    const timings: number[] = []; let cursor: string | null = null, maxBytes = 0, count = 0;
    do {
      const before = performance.now();
      const page = graphChunk(snapshot, new URLSearchParams({ kind, limit: kind === 'nodes' ? '500' : '1000', ...(cursor ? { cursor } : {}) }));
      const bytes = Buffer.byteLength(JSON.stringify(page));
      timings.push(performance.now() - before); maxBytes = Math.max(maxBytes, bytes); count += page.items.length; cursor = page.nextCursor;
    } while (cursor);
    const ordered = [...timings].sort((a, b) => a - b);
    return { kind, count, pages: timings.length, maxBytes, totalMs: Number(timings.reduce((a, b) => a + b, 0).toFixed(2)), p95PageMs: Number(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * .95) - 1)]!.toFixed(2)) };
  });
  return { files, edges: files * 4, seed: 42, state: 'cold fixture, sequential in-process calls; no database or network', metadataMs: Number(metadataMs.toFixed(2)), metadataBytes: Buffer.byteLength(JSON.stringify(metadata)), kinds, heapDeltaBytes: process.memoryUsage().heapUsed - startHeap };
});
console.log(JSON.stringify({ measuredAt: new Date().toISOString(), runtime: process.version, hardware: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() }, fixtures, limits: { responseBytes: 512_000, nodesPerPage: 500, edgesPerPage: 1_000, fileDetailEdges: 200 }, note: 'Single sample under concurrent agent load; heap deltas include allocations and garbage collection. Not a PostgreSQL, HTTP, browser, or release capacity claim.' }, null, 2));
