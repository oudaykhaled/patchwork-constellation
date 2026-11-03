import { performance } from 'node:perf_hooks';
import { createScaleFixture } from '../../fixtures/src/index';
import { layoutGraph, neighborsOf, selectedMembership } from './index';

const results = [212, 2000, 10000].map(count => {
  const graph = createScaleFixture(count, count === 212 ? 235 : count * 4, 42);
  const timings: number[] = [];
  for (let run = 0; run < 25; run++) {
    const start = performance.now();
    layoutGraph(graph); selectedMembership(graph, graph.sources.map(source => source.id)); neighborsOf(graph.edges, graph.nodes[0]?.id ?? null);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return { files: graph.nodes.length, edges: graph.edges.length, seed: 42, runs: timings.length, medianMs: +timings[12].toFixed(2), p95Ms: +timings[23].toFixed(2) };
});
console.log(JSON.stringify({ measured: 'CPU layout + footprint + neighbor computation; excludes browser canvas rendering and network', node: process.version, platform: process.platform, architecture: process.arch, results }, null, 2));
