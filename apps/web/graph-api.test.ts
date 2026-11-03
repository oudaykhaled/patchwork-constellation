import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createScaleFixture, demoSnapshot } from '@patchwork/fixtures';
import { fileDetail, graphChunk, graphMetadata, graphVersion } from './graph-api';

describe('bounded progressive graph API', () => {
  it('delivers summaries before file/edge data and exposes exact counts and coverage', () => {
    const metadata = graphMetadata(demoSnapshot);
    expect(metadata.counts).toMatchObject({ files: 212, groups: 6, edges: 235 });
    expect(metadata).not.toHaveProperty('nodes'); expect(metadata).not.toHaveProperty('edges');
    expect(metadata.groups.reduce((count, group) => count + group.fileCount, 0)).toBe(212);
    expect(metadata.coverage).toEqual(demoSnapshot.coverage);
  });
  it('pages every node exactly once and rejects stale or cross-scope cursors', () => {
    const first = graphChunk(demoSnapshot, new URLSearchParams('limit=100'));
    expect(first.items).toHaveLength(100); expect(first.nextCursor).not.toBeNull();
    const next = graphChunk(demoSnapshot, new URLSearchParams({ limit: '100', cursor: first.nextCursor! }));
    expect(next.items).toHaveLength(100);
    const final = graphChunk(demoSnapshot, new URLSearchParams({ limit: '100', cursor: next.nextCursor! }));
    expect(final.items).toHaveLength(12); expect(final.nextCursor).toBeNull();
    expect(new Set([...first.items, ...next.items, ...final.items].map(item => (item as { id: string }).id)).size).toBe(212);
    expect(() => graphChunk(demoSnapshot, new URLSearchParams({ kind: 'edges', cursor: first.nextCursor! }))).toThrow('scope');
    const changed = structuredClone(demoSnapshot); changed.groups[0]!.label = 'New revision';
    expect(() => graphChunk(changed, new URLSearchParams({ cursor: first.nextCursor! }))).toThrow('revision changed');
    for (const query of ['limit=501', 'limit=0', 'limit=NaN', 'cursor=%%%', 'kind=unknown', 'groupId=missing']) expect(() => graphChunk(demoSnapshot, new URLSearchParams(query))).toThrow();
  });
  it('filters edges to known group nodes, preserving relation evidence and explicit exclusions', () => {
    const groupId = demoSnapshot.groups[0]!.id;
    const nodes = graphChunk(demoSnapshot, new URLSearchParams({ groupId, limit: '500' }));
    const edges = graphChunk(demoSnapshot, new URLSearchParams({ kind: 'edges', groupId, limit: '1000' }));
    const ids = new Set(nodes.items.map(item => (item as { id: string }).id));
    for (const edge of edges.items as typeof demoSnapshot.edges) { expect(ids.has(edge.source)).toBe(true); expect(ids.has(edge.target)).toBe(true); expect(edge.evidence).toBeDefined(); }
    expect(edges.total + edges.excludedCrossGroupEdges).toBe(demoSnapshot.edges.length);
    expect(edges.edgeEndpointScope).toBe('selected-group');
  });
  it('file detail returns source pairs and bounded incident-edge evidence', () => {
    const file = demoSnapshot.sources[0]!.files[0]!;
    const detail = fileDetail(demoSnapshot, file.fileId);
    expect(detail.file.id).toBe(file.fileId); expect(detail.sources.length).toBeGreaterThan(0);
    expect(detail.sources[0]!.baseSha).toBeDefined(); expect(detail.version).toBe(graphVersion(demoSnapshot));
    expect(detail.edges.every(edge => edge.source === file.fileId || edge.target === file.fileId)).toBe(true);
    expect(() => fileDetail(demoSnapshot, 'missing')).toThrow('unavailable');
  });
  for (const count of [1_000, 10_000]) it(`keeps ${count}-file page and query budgets explicit`, () => {
    const snapshot = createScaleFixture(count, count * 4, 42), started = performance.now();
    const metadata = graphMetadata(snapshot); const metadataMs = performance.now() - started;
    const measurements: { kind: string; pages: number; items: number; maxBytes: number; totalMs: number }[] = [];
    for (const kind of ['nodes', 'edges']) {
      const start = performance.now(); let cursor: string | null = null, total = 0, pages = 0, maxBytes = 0;
      do {
        const page = graphChunk(snapshot, new URLSearchParams({ kind, limit: kind === 'nodes' ? '500' : '1000', ...(cursor ? { cursor } : {}) }));
        const bytes = Buffer.byteLength(JSON.stringify(page)); maxBytes = Math.max(maxBytes, bytes); expect(bytes).toBeLessThan(512_000);
        pages++; total += page.items.length; cursor = page.nextCursor;
      } while (cursor);
      expect(total).toBe(kind === 'nodes' ? count : count * 4);
      measurements.push({ kind, pages, items: total, maxBytes, totalMs: Number((performance.now() - start).toFixed(2)) });
    }
    expect(metadata.counts.files).toBe(count);
    // Generous safety bound catches accidentally quadratic/unbounded response behavior, not laptop marketing claims.
    expect(performance.now() - started).toBeLessThan(10_000);
    console.info(JSON.stringify({ graphApiBudget: { fixture: `${count}/${count * 4}`, seed: 42, metadataMs: Number(metadataMs.toFixed(2)), metadataBytes: Buffer.byteLength(JSON.stringify(metadata)), measurements } }));
  });
});
