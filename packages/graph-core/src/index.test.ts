import { describe, expect, it } from 'vitest';
import { createDemoSnapshot, createScaleFixture } from '../../fixtures/src/index';
import { fitCamera, islandBounds, layoutGraph, neighborsOf, preserveLayout, screenToWorld, selectedMembership, worldToScreen, zoomAt } from './index';

describe('Constellation layout and source semantics', () => {
  it('lays out each actual file exactly once and includes every file within its island', () => {
    const graph = createDemoSnapshot(); const layout = layoutGraph(graph);
    expect(layout.nodes).toHaveLength(212); expect(layout.islands).toHaveLength(6);
    expect(new Set(layout.nodes.map(node => node.id)).size).toBe(212);
    for (const island of layout.islands) for (const node of island.nodes) {
      expect(Math.abs(node.x - island.x)).toBeLessThan(island.rx);
      expect(Math.abs(node.y - island.y)).toBeLessThan(island.ry);
    }
  });
  it('is deterministic and preserves file positions when input nodes or sources are reordered', () => {
    const graph = createDemoSnapshot();
    const before = layoutGraph(graph).nodeById;
    const after = layoutGraph({ ...graph, nodes: [...graph.nodes].reverse(), sources: [...graph.sources].reverse() }).nodeById;
    for (const [id, node] of before) expect(after.get(id)).toEqual(node);
  });
  it('source toggles change footprints, never coordinates', () => {
    const graph = createDemoSnapshot(); const before = layoutGraph(graph);
    const three = selectedMembership(graph, ['pr-248', 'pr-251', 'pr-256']);
    const two = selectedMembership(graph, ['pr-248', 'pr-251']);
    expect(three.size).toBe(68); expect([...three.values()].filter(count => count > 1)).toHaveLength(14);
    expect(two.size).toBe(57); expect([...two.values()].filter(count => count > 1)).toHaveLength(2);
    expect(selectedMembership(graph, ['pr-248', 'pr-248']).size).toBe(selectedMembership(graph, ['pr-248']).size);
    expect(layoutGraph(graph).nodes).toEqual(before.nodes);
  });
  it('has exact independent commit union and overlap, including no-selection context', () => {
    const graph = createDemoSnapshot(); const commits = selectedMembership(graph, ['commit-a81f3c2', 'commit-b72d9e1']);
    expect(commits.size).toBe(24); expect([...commits.values()].filter(count => count > 1)).toHaveLength(4);
    expect(selectedMembership(graph, [])).toHaveLength(0);
  });
  it('honors one island per file in a 10k-file stress fixture without silently dropping files', () => {
    const graph = createScaleFixture(10000, 40000, 42); const layout = layoutGraph(graph);
    expect(layout.nodeById.size).toBe(10000); expect(layout.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(layout.islands.reduce((total, island) => total + island.nodes.length, 0)).toBe(10000);
  });
  it('handles unknown group references with an explicit Ungrouped island', () => {
    const layout = layoutGraph({ nodes: [{ id: 'file', path: 'file.ts', groupId: 'missing' }], groups: [], edges: [] });
    expect(layout.islands[0].label).toBe('Ungrouped'); expect(layout.nodes).toHaveLength(1);
  });
  it('retains existing file coordinates when a source overlay adds files', () => {
    const graph = createDemoSnapshot(); const before = layoutGraph(graph);
    const updated = { ...graph, nodes: [...graph.nodes, { ...graph.nodes[0], id: 'source-only', path: 'src/auth/new.ts', sourceIds: ['pr-256'] }] };
    const stable = preserveLayout(before, layoutGraph(updated));
    for (const [id, node] of before.nodeById) { expect(stable.nodeById.get(id)?.x).toBe(node.x); expect(stable.nodeById.get(id)?.y).toBe(node.y); }
    expect(stable.nodeById.size).toBe(213); expect(stable.bounds).toEqual(before.bounds);
  });
});

describe('camera coordinate transformations', () => {
  it('round trips a pointer coordinate at arbitrary pan and zoom', () => {
    const camera = { x: 935, y: -45, zoom: 2.35 }; const point = { x: 373, y: 218 };
    const world = screenToWorld(point, camera, 1440, 900); const roundtrip = worldToScreen(world, camera, 1440, 900);
    expect(roundtrip.x).toBeCloseTo(point.x); expect(roundtrip.y).toBeCloseTo(point.y);
  });
  it('zooming preserves the world point under the pointer', () => {
    const camera = { x: 750, y: 430, zoom: .8 }; const pointer = { x: 275, y: 618 };
    const before = screenToWorld(pointer, camera, 1600, 1000); const zoomed = zoomAt(camera, 2.5, pointer, 1600, 1000);
    const after = screenToWorld(pointer, zoomed, 1600, 1000);
    expect(after.x).toBeCloseTo(before.x); expect(after.y).toBeCloseTo(before.y);
  });
  it('fit respects bounds and island focus', () => {
    const graph = layoutGraph(createDemoSnapshot()); const island = graph.islands[0];
    const bounds = islandBounds(island); const camera = fitCamera(bounds, 1440, 900, 130);
    const topLeft = worldToScreen(bounds, camera, 1440, 900);
    expect(topLeft.x).toBeGreaterThanOrEqual(129); expect(topLeft.y).toBeGreaterThanOrEqual(129);
    expect(camera.zoom).toBeGreaterThan(fitCamera(graph.bounds, 1440, 900).zoom);
  });
  it('neighbor focus includes both import directions and excludes unrelated files', () => {
    const neighbors = neighborsOf([{ id: 'a', source: 'one', target: 'two' }, { id: 'b', source: 'three', target: 'one' }, { id: 'c', source: 'four', target: 'five' }], 'one');
    expect([...neighbors].sort()).toEqual(['three', 'two']); expect(neighborsOf([], null).size).toBe(0);
  });
});
