import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileNode, ImportEdge } from '@patchwork/contracts';
import { createScaleFixture } from '@patchwork/fixtures';
import { createStore, type SnapshotStore } from '@patchwork/storage';
import { createApplicationServer } from '../../apps/web/server';

const snapshot = createScaleFixture(10_000, 40_000, 42);
let store: SnapshotStore, server: Server, origin: string;
beforeAll(async () => {
  store = await createStore({ databaseUrl: '', maxSnapshots: 4 });
  await store.putSnapshot({ ownerId: 'local-public', repository: snapshot.repository.fullName }, snapshot);
  await store.putSnapshot({ ownerId: 'other-account', repository: snapshot.repository.fullName }, { ...snapshot, id: 'other-account-only' });
  server = await createApplicationServer({ production: true, store });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

describe('10k-file progressive HTTP release gate', () => {
  it('delivers bounded metadata, all nodes and all edges without duplicates or dangling references', async () => {
    const query = `repository=${encodeURIComponent(snapshot.repository.fullName)}`;
    const metadataResponse = await fetch(`${origin}/api/graphs/${snapshot.id}?${query}`);
    expect(metadataResponse.status).toBe(200);
    const metadata = await metadataResponse.json();
    expect(metadata.counts).toMatchObject({ files: 10_000, edges: 40_000, groups: 12 });
    expect(metadata.nodes).toBeUndefined(); expect(metadata.edges).toBeUndefined();
    expect(metadata.groups.reduce((total: number, group: { fileCount: number }) => total + group.fileCount, 0)).toBe(10_000);
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThan(512_000);
    const nodes = new Map<string, FileNode>(), edges = new Map<string, ImportEdge>();
    for (const kind of ['nodes', 'edges']) {
      let cursor: string | null = null, pages = 0;
      do {
        const params = new URLSearchParams({ repository: snapshot.repository.fullName, kind, version: metadata.version, limit: kind === 'nodes' ? '500' : '1000', ...(cursor ? { cursor } : {}) });
        const response = await fetch(`${origin}/api/graphs/${snapshot.id}/chunks?${params}`);
        expect(response.status).toBe(200);
        const text = await response.text(); expect(Buffer.byteLength(text)).toBeLessThan(512_000);
        const page = JSON.parse(text);
        expect(page.total).toBe(kind === 'nodes' ? 10_000 : 40_000);
        expect(page.version).toBe(metadata.version); expect(page.coverage).toEqual(snapshot.coverage);
        for (const item of page.items as (FileNode & ImportEdge)[]) {
          const map = kind === 'nodes' ? nodes : edges;
          expect(map.has(item.id)).toBe(false);
          (map as Map<string, unknown>).set(item.id, item);
        }
        pages++; cursor = page.nextCursor;
      } while (cursor && pages <= 100);
      expect(cursor).toBeNull(); expect(pages).toBe(kind === 'nodes' ? 20 : 40);
    }
    expect(nodes.size).toBe(10_000); expect(edges.size).toBe(40_000);
    for (const edge of edges.values()) { expect(nodes.has(edge.source)).toBe(true); expect(nodes.has(edge.target)).toBe(true); expect(edge.evidence).toBeDefined(); }
    const invalidVersion = await fetch(`${origin}/api/graphs/${snapshot.id}/chunks?${query}&version=wrong`);
    expect(invalidVersion.status).toBe(409); expect((await invalidVersion.json()).code).toBe('STALE_VERSION');
  }, 30_000);

  it('keeps group-filtered edges closed over the selected group and refuses foreign account objects', async () => {
    const groupId = snapshot.groups[0]!.id;
    const groupNodes = new Set(snapshot.nodes.filter(node => node.groupId === groupId).map(node => node.id));
    const query = new URLSearchParams({ repository: snapshot.repository.fullName, groupId, kind: 'edges', limit: '1000' });
    const response = await fetch(`${origin}/api/graphs/${snapshot.id}/chunks?${query}`);
    expect(response.status).toBe(200);
    const page = await response.json();
    for (const edge of page.items as ImportEdge[]) { expect(groupNodes.has(edge.source)).toBe(true); expect(groupNodes.has(edge.target)).toBe(true); }
    expect(page.total + page.excludedCrossGroupEdges).toBe(40_000);
    expect(page.edgeEndpointScope).toBe('selected-group');
    const foreign = await fetch(`${origin}/api/graphs/other-account-only?repository=${encodeURIComponent(snapshot.repository.fullName)}`);
    expect(foreign.status).toBe(404);
    const wrongRepo = await fetch(`${origin}/api/graphs/${snapshot.id}?repository=other%2Frepository`);
    expect(wrongRepo.status).toBe(404);
    const foreignFile = await fetch(`${origin}/api/files/other-account-only/${snapshot.nodes[0]!.id}?repository=${encodeURIComponent(snapshot.repository.fullName)}`);
    expect(foreignFile.status).toBe(404);
  });
});
