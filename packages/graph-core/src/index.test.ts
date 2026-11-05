import { describe, expect, it } from 'vitest';
import { GROUP_PALETTE } from '../../analysis/src/groups';
import { createDemoSnapshot, createScaleFixture } from '../../fixtures/src/index';
import { fitCamera, ISLAND_ALPHA, ISLAND_GEOMETRY, ISLAND_SLOT_INSET, islandBounds, islandIdentityColor, islandCapacity, islandTier, layoutGraph, layoutPitch, MAP_BACKGROUND, neighborsOf, packIslands, preserveLayout, screenToWorld, selectedMembership, worldToScreen, zoomAt } from './index';
import type { GraphData } from './index';

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

describe('rectangle islands sized by file count', () => {
  const syntheticGraph = (sizes: number[]): GraphData => ({
    groups: sizes.map((_, i) => ({ id: `g${String(i).padStart(3, '0')}`, label: `Group ${i}` })),
    nodes: sizes.flatMap((count, i) => Array.from({ length: count }, (_, j) => ({ id: `g${i}-f${j}`, path: `g${i}/f${String(j).padStart(4, '0')}.ts`, groupId: `g${String(i).padStart(3, '0')}` }))),
    edges: [],
  });
  it('tiers are the smallest square or one-wider landscape module block that holds every file', () => {
    expect(islandTier(0)).toEqual({ w: 1, h: 1 });
    expect(islandTier(4)).toEqual({ w: 1, h: 1 });
    expect(islandTier(5)).toEqual({ w: 2, h: 1 });
    expect(islandTier(13)).toEqual({ w: 2, h: 2 });
    expect(islandTier(37)).toEqual({ w: 3, h: 2 });
    expect(islandTier(900)).toEqual({ w: 8, h: 8 });
    expect(islandTier(2000)).toEqual({ w: 12, h: 12 });
    let previousArea = 0;
    for (let files = 0; files <= 1200; files++) {
      const { w, h } = islandTier(files);
      expect(islandCapacity(w, h)).toBeGreaterThanOrEqual(Math.max(1, files));
      expect(w).toBeGreaterThanOrEqual(h); expect(w).toBeLessThanOrEqual(h + 1);
      expect(w * h).toBeGreaterThanOrEqual(previousArea); previousArea = w * h;
    }
  });
  it('dense first-fit never overlaps and lets later small islands fill holes left by big ones', () => {
    const packing = packIslands([{ w: 3, h: 3 }, { w: 2, h: 1 }, { w: 3, h: 3 }, { w: 1, h: 1 }, { w: 1, h: 1 }, { w: 1, h: 1 }]);
    const cells = new Set<string>();
    packing.cells.forEach(({ col, row }, i) => {
      const tier = [{ w: 3, h: 3 }, { w: 2, h: 1 }, { w: 3, h: 3 }, { w: 1, h: 1 }, { w: 1, h: 1 }, { w: 1, h: 1 }][i];
      expect(col + tier.w).toBeLessThanOrEqual(packing.columns);
      for (let x = col; x < col + tier.w; x++) for (let y = row; y < row + tier.h; y++) { expect(cells.has(`${x}:${y}`)).toBe(false); cells.add(`${x}:${y}`); }
    });
    // ceil(sqrt(23 cells × 2.2)) = 8 columns: 3×3, 2×1 and 3×3 share row 0; the three
    // 1×1 islands then fill the hole under the 2×1 instead of starting a new row.
    expect(packing.columns).toBe(8);
    expect(packing.cells.slice(0, 3)).toEqual([{ col: 0, row: 0 }, { col: 3, row: 0 }, { col: 5, row: 0 }]);
    expect(packing.cells.slice(3)).toEqual([{ col: 3, row: 1 }, { col: 4, row: 1 }, { col: 3, row: 2 }]);
    expect(packing.rows).toBe(3);
  });
  it('lays out rounded rectangles that never overlap, keep a gutter, and grow with their file count', () => {
    const layout = layoutGraph(syntheticGraph([1, 3, 9, 40, 120, 600, 0, 5]));
    const scale = layoutPitch(layout) / ISLAND_GEOMETRY.pitch;
    for (const island of layout.islands) for (const other of layout.islands) if (island !== other) {
      const gapX = Math.abs(island.x - other.x) - island.rx - other.rx, gapY = Math.abs(island.y - other.y) - island.ry - other.ry;
      expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(ISLAND_GEOMETRY.gutter * scale - 1e-9);
    }
    const area = (files: number) => { const island = layout.islands.find(group => group.nodes.length === files)!; return island.rx * island.ry; };
    expect(area(1)).toBeLessThanOrEqual(area(3)); expect(area(3)).toBeLessThan(area(9));
    expect(area(9)).toBeLessThan(area(40)); expect(area(40)).toBeLessThan(area(120)); expect(area(120)).toBeLessThan(area(600));
    expect(layout.islands.find(island => !island.nodes.length)).toMatchObject({ rx: 36 * scale, ry: 36 * scale });
    for (const island of layout.islands) for (const node of island.nodes) {
      expect(Math.abs(node.x - island.x)).toBeLessThanOrEqual(island.rx - (ISLAND_GEOMETRY.padding + ISLAND_GEOMETRY.pitch / 2) * scale + 1e-9);
      expect(Math.abs(node.y - island.y)).toBeLessThanOrEqual(island.ry - (ISLAND_GEOMETRY.padding + ISLAND_GEOMETRY.pitch / 2) * scale + 1e-9);
    }
  });
  it('places files on one lattice pitch per layout and centres a small island\'s files as one row', () => {
    const layout = layoutGraph(syntheticGraph([5, 50]));
    const five = layout.islands.find(island => island.nodes.length === 5)!;
    expect(new Set(five.nodes.map(node => node.y)).size).toBe(1);
    expect(five.nodes[0].y).toBe(five.y);
    expect((five.nodes[0].x + five.nodes[4].x) / 2).toBeCloseTo(five.x, 6);
    const fifty = layout.islands.find(island => island.nodes.length === 50)!;
    for (const node of fifty.nodes) {
      expect(((node.x - fifty.grid!.originX) / layoutPitch(layout)) % 1).toBeCloseTo(0, 9);
      expect(((node.y - fifty.grid!.originY) / layoutPitch(layout)) % 1).toBeCloseTo(0, 9);
    }
    expect(layoutPitch(layoutGraph(syntheticGraph(Array.from({ length: 200 }, () => 30))))).toBe(ISLAND_GEOMETRY.pitch);
  });
  it('scales the demo block up to fill the minimum 1600×936 world and fits a large repository without a minimum', () => {
    const demo = layoutGraph(createDemoSnapshot());
    expect(demo.bounds).toEqual({ x: 0, y: 0, width: 1600, height: 936 });
    expect(layoutPitch(demo)).toBeGreaterThan(ISLAND_GEOMETRY.pitch * 1.5);
    expect(layoutPitch(demo)).toBeLessThanOrEqual(ISLAND_GEOMETRY.pitch * 2.5);
    const left = Math.min(...demo.islands.map(island => island.x - island.rx)), right = Math.max(...demo.islands.map(island => island.x + island.rx));
    const top = Math.min(...demo.islands.map(island => island.y - island.ry)), bottom = Math.max(...demo.islands.map(island => island.y + island.ry));
    expect(Math.max((right - left) / 1500, (bottom - top) / 816)).toBeCloseTo(1, 6);
    expect(left - demo.bounds.x).toBeCloseTo(demo.bounds.x + demo.bounds.width - right, 6);
    expect(top - demo.bounds.y).toBeCloseTo(demo.bounds.y + demo.bounds.height - bottom, 6);
    const large = layoutGraph(syntheticGraph(Array.from({ length: 200 }, (_, i) => 1 + (i * 37) % 300)));
    expect(Math.min(...large.islands.map(island => island.x - island.rx))).toBe(50);
    expect(Math.min(...large.islands.map(island => island.y - island.ry))).toBe(60);
    expect(large.bounds.width / large.bounds.height).toBeGreaterThan(1.4);
  });
  const overlappingPairs = (islands: readonly { x: number; y: number; rx: number; ry: number }[]) => {
    let pairs = 0;
    islands.forEach((a, i) => islands.slice(i + 1).forEach(b => { if (Math.abs(a.x - b.x) < a.rx + b.rx && Math.abs(a.y - b.y) < a.ry + b.ry) pairs++; }));
    return pairs;
  };
  it('appends a source-only file to the next free lattice slot without moving any file or rectangle', () => {
    const graph = syntheticGraph([10, 6]);
    const before = layoutGraph(graph);
    const roomy = before.islands.find(island => island.nodes.length === 10)!;
    const added = { ...graph, nodes: [...graph.nodes, { id: 'extra', path: 'g0/zzzz.ts', groupId: roomy.id }] };
    const stable = preserveLayout(before, layoutGraph(added));
    for (const [id, node] of before.nodeById) expect(stable.nodeById.get(id)).toMatchObject({ x: node.x, y: node.y });
    const kept = stable.islands.find(island => island.id === roomy.id)!, extra = stable.nodeById.get('extra')!;
    expect(kept).toMatchObject({ x: roomy.x, y: roomy.y, rx: roomy.rx, ry: roomy.ry });
    expect(new Set(stable.nodes.map(node => `${node.x}:${node.y}`)).size).toBe(stable.nodes.length);
    expect(Math.abs(extra.x - kept.x)).toBeLessThanOrEqual(kept.rx - ISLAND_SLOT_INSET + 1e-9);
    expect(Math.abs(extra.y - kept.y)).toBeLessThanOrEqual(kept.ry - ISLAND_SLOT_INSET + 1e-9);
    expect(stable.bounds).toEqual(before.bounds);
  });
  it('re-packs the whole map when a source-only overlay overflows an island, so no island runs over a neighbour', () => {
    // A 1 × 1 island (3 inventory files) receives 40 selection-only files. It must not become
    // a 2-wide strip over its neighbours.
    const graph = syntheticGraph([3, 30, 12, 60, 4, 4, 20, 9, 36, 5, 2, 14]);
    const before = layoutGraph(graph);
    const small = before.islands.find(island => island.id === 'g000')!;
    const unit = (layout: typeof before) => layoutPitch(layout) / ISLAND_GEOMETRY.pitch;
    expect(small.rx * 2).toBeCloseTo((ISLAND_GEOMETRY.module - ISLAND_GEOMETRY.gutter) * unit(before), 9);
    const added = { ...graph, nodes: [...graph.nodes, ...Array.from({ length: 40 }, (_, i) => ({ id: `extra-${i}`, path: `g0/new-${String(i).padStart(2, '0')}.ts`, groupId: small.id }))] };
    const fresh = layoutGraph(added);
    const stable = preserveLayout(before, fresh);
    expect(overlappingPairs(stable.islands)).toBe(0);
    // It is exactly the map a direct load of the same files shows (path independent).
    expect(stable).toBe(fresh);
    const grown = stable.islands.find(island => island.id === small.id)!;
    expect(grown.nodes).toHaveLength(43);
    const module = (half: number) => Math.round((half * 2 / unit(stable) + ISLAND_GEOMETRY.gutter) / ISLAND_GEOMETRY.module);
    expect({ w: module(grown.rx), h: module(grown.ry) }).toEqual(islandTier(43));
    for (const island of stable.islands) for (const node of island.nodes) { expect(Math.abs(node.x - island.x)).toBeLessThan(island.rx); expect(Math.abs(node.y - island.y)).toBeLessThan(island.ry); }
    expect(new Set(stable.nodes.map(node => `${node.x}:${node.y}`)).size).toBe(stable.nodes.length);
  });
  it('a 10k-file map receiving overflow in many islands at once stays free of overlaps', () => {
    const graph = createScaleFixture(10_000, 0, 42);
    const before = layoutGraph(graph);
    const extra = before.islands.flatMap((island, i) => Array.from({ length: 40 + i * 7 }, (_, j) => ({ id: `overlay-${i}-${j}`, path: `overlay/${i}/${j}.ts`, groupId: island.id })));
    const stable = preserveLayout(before, layoutGraph({ ...graph, nodes: [...graph.nodes, ...extra] }));
    expect(overlappingPairs(stable.islands)).toBe(0);
    expect(stable.nodes).toHaveLength(10_000 + extra.length);
  });
  it('re-packs when a new island\'s packed place is taken, instead of parking it beside the block', () => {
    const graph = syntheticGraph(Array.from({ length: 40 }, (_, i) => 5 + (i * 13) % 60));
    const before = layoutGraph(graph);
    const extra = ['a-new', 'b-new', 'c-new']; // Sorted first, so a fresh packing puts them where survivors are.
    const next = { ...graph, groups: [...graph.groups, ...extra.map(id => ({ id, label: id }))], nodes: [...graph.nodes, ...extra.flatMap(id => Array.from({ length: 8 }, (_, j) => ({ id: `${id}-${j}`, path: `${id}/f${j}.ts`, groupId: id })))] };
    const fresh = layoutGraph(next);
    const stable = preserveLayout(before, fresh);
    expect(stable).toBe(fresh);
    expect(overlappingPairs(stable.islands)).toBe(0);
    // Every island stays inside the packed block: nothing sticks out to the right of it.
    const right = Math.max(...stable.islands.map(island => island.x + island.rx));
    expect(right).toBeLessThanOrEqual(stable.bounds.x + stable.bounds.width - 50 + 1e-9);
  });
  it('keeps the map when a new island\'s packed place is free', () => {
    // Eight 5 × 5 islands (a world too large to be scaled up); a one-file group sorted last
    // packs onto a free cell after them, so nothing moves.
    const graph = syntheticGraph(Array.from({ length: 8 }, () => 300));
    const before = layoutGraph(graph);
    const next = { ...graph, groups: [...graph.groups, { id: 'zz-new', label: 'New' }], nodes: [...graph.nodes, { id: 'zz-0', path: 'zz/a.ts', groupId: 'zz-new' }] };
    const fresh = layoutGraph(next);
    const stable = preserveLayout(before, fresh);
    expect(stable).not.toBe(fresh);
    for (const [id, node] of before.nodeById) expect(stable.nodeById.get(id)).toMatchObject({ x: node.x, y: node.y });
    const added = stable.islands.find(island => island.id === 'zz-new')!, packed = fresh.islands.find(island => island.id === 'zz-new')!;
    expect(added).toMatchObject({ x: packed.x, y: packed.y, rx: packed.rx, ry: packed.ry });
    expect(overlappingPairs(stable.islands)).toBe(0);
    expect(stable.bounds.x + stable.bounds.width).toBeGreaterThanOrEqual(added.x + added.rx);
  });
});

describe('island identity colours', () => {
  const hue = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), delta = max - Math.min(r, g, b);
    return (max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60;
  };
  const CHANGED_HUE = hue('#42b968');
  // The analysis palette; the layout fallback palette is its first six.
  const palette = GROUP_PALETTE;
  const saturation = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), lightness = (max + min) / 2;
    return (max - min) / (1 - Math.abs(2 * lightness - 1));
  };
  it('moves olive, yellow-green and green-teal identities away from the changed green', () => {
    for (const color of palette) {
      const shown = islandIdentityColor(color);
      expect(shown).toMatch(/^#[0-9a-f]{6}$/);
      expect(Math.abs(hue(shown) - CHANGED_HUE)).toBeGreaterThanOrEqual(30);
      if (hue(color) < 60 || hue(color) > 170) expect(shown).toBe(color);
      expect(saturation(shown)).toBeCloseTo(saturation(color), 1);
    }
    expect(hue(islandIdentityColor('#66bfa0'))).toBeGreaterThanOrEqual(172);
    expect(hue(islandIdentityColor('#66bfa0'))).toBeLessThanOrEqual(180);
    // Olive goes warm (brick red), not into the cool blues.
    const olive = hue(islandIdentityColor('#98ac7a'));
    expect(olive >= 345 || olive <= 15).toBe(true);
    expect(islandIdentityColor('#98ac7a')).not.toBe(islandIdentityColor('#66bfa0'));
    expect(islandIdentityColor('#7f7f7f')).toBe('#7f7f7f');
    expect(islandIdentityColor('teal')).toBe('teal');
  });
  it('keeps the shown palette hues apart, so neighbouring islands are told apart', () => {
    // Coloured identities are at least 20° apart. The near-grey (#839da0, saturation 0.13) is
    // told apart by its greyness, not its hue.
    const shown = palette.map(islandIdentityColor).filter(color => saturation(color) >= .15).map(hue);
    expect(shown).toHaveLength(7);
    for (const [index, a] of shown.entries()) for (const b of shown.slice(index + 1)) expect(Math.min(Math.abs(a - b), 360 - Math.abs(a - b))).toBeGreaterThanOrEqual(20);
  });
  it('keeps every unchanged island border at 3:1 or more against the map and its own fill', () => {
    // WCAG 1.4.11 contrast of the canvas composite: border over the map, and border over the fill.
    const rgb = (hex: string) => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
    const over = (top: number[], opacity: string, under: number[]) => top.map((value, i) => value * Number.parseInt(opacity, 16) / 255 + under[i]! * (1 - Number.parseInt(opacity, 16) / 255));
    const luminance = (color: number[]) => {
      const [r, g, b] = color.map(value => value / 255).map(value => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return .2126 * r! + .7152 * g! + .0722 * b!;
    };
    const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
    const map = rgb(MAP_BACKGROUND);
    // Analysis palette, demo sample and layout fallback palette, as the map shows them.
    const shown = new Set([
      ...palette.map(islandIdentityColor),
      ...layoutGraph(createDemoSnapshot()).islands.map(island => island.color),
      ...layoutGraph(createScaleFixture(600, 0, 7)).islands.map(island => island.color)
    ].map(color => color.toLowerCase()));
    expect(shown.size).toBeGreaterThanOrEqual(8);
    for (const color of shown) {
      const island = rgb(color), fill = over(island, ISLAND_ALPHA.fill, map);
      expect(contrast(over(island, ISLAND_ALPHA.border, map), map), `${color} against the map`).toBeGreaterThanOrEqual(3);
      expect(contrast(over(island, ISLAND_ALPHA.border, fill), fill), `${color} against its fill`).toBeGreaterThanOrEqual(3);
    }
  });
  it('lays out islands whose identity colours are never green', () => {
    const layout = layoutGraph(createScaleFixture(600, 0, 7));
    for (const island of layout.islands) expect(Math.abs(hue(island.color) - CHANGED_HUE)).toBeGreaterThanOrEqual(30);
    expect(layoutGraph(createDemoSnapshot()).islands.find(island => island.id === 'auth')!.color).toBe(islandIdentityColor('#66BFA0'));
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
