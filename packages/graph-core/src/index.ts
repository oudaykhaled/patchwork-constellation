/** Pure, deterministic graph presentation. Selection never participates in layout. */
export interface LayoutFile { id: string; path: string; groupId: string; sourceIds?: string[] }
export interface LayoutGroup { id: string; label: string; color?: string }
export interface LayoutEdge { id: string; source: string; target: string }
export interface GraphData {
  nodes: LayoutFile[];
  groups: LayoutGroup[];
  edges: LayoutEdge[];
  sources?: { id: string; files: { fileId: string }[] }[];
}
export interface Point { x: number; y: number }
export interface Bounds { x: number; y: number; width: number; height: number }
export interface Camera { x: number; y: number; zoom: number }
export interface PositionedFile extends LayoutFile, Point {}
/**
 * Free-slot frame of an island's file lattice: slot k sits at origin + (k mod columns, floor(k / columns)) × pitch.
 * The frame spans the rectangle's full lattice width on the same half-pitch alignment as the placed files, so a
 * source-only file can take a free slot without moving or overlapping any existing file.
 */
export interface IslandGrid { originX: number; originY: number; columns: number; pitch: number }
export interface Island extends LayoutGroup, Point {
  /** Half-width and half-height of the island rectangle, centred on x/y. */
  rx: number; ry: number; nodes: PositionedFile[]; color: string; grid?: IslandGrid;
}
export interface GraphLayout { nodes: PositionedFile[]; nodeById: Map<string, PositionedFile>; islands: Island[]; bounds: Bounds }
export interface LayoutOptions { seed?: number }

/** World-space geometry of the rectangle island treatment. */
export const ISLAND_GEOMETRY = Object.freeze({
  /** File lattice pitch, centre to centre. */ pitch: 24,
  /** Module cell; an island is w × h modules. */ module: 96,
  /** Gutter between island rectangles. */ gutter: 24,
  /** Inset from the rectangle edge to the first file slot edge. */ padding: 12,
});
const { pitch: P, module: U, gutter: G, padding: PAD } = ISLAND_GEOMETRY;
/** Inset from a rectangle edge to the centre of its outermost file slot. */
export const ISLAND_SLOT_INSET = PAD + P / 2;
const MIN_BOUNDS = { width: 1600, height: 936 };
/** A packed block smaller than the minimum world is scaled up (at most this much) to fill it. */
const MAX_SMALL_WORLD_SCALE = 2.5;
/** Canvas background of the map (the `.constellation-graph` CSS uses the same colour). */
export const MAP_BACKGROUND = '#091216';
/**
 * Two-digit hex alpha suffixes for island rectangles, appended to the identity colour.
 * `border` (b8, 72%) is the unchanged-island outline: for every identity colour of the palettes it
 * keeps at least 3:1 contrast against the map and against the island's own `fill`. A unit test
 * asserts this; at a0 (63%) orchid and brick dropped to 2.9:1 and 2.7:1.
 */
export const ISLAND_ALPHA = Object.freeze({ fill: '0f', changedFill: '17', dimmedFill: '0a', border: 'b8' });
/** Matches the analysis palette (packages/analysis/src/groups.ts); one blue is orchid so blues stay apart. */
const PALETTE = ['#66BFA0', '#9D8FD4', '#6A9EC7', '#B8A073', '#B377C3', '#839DA0'];

/**
 * Island identity colour. Green means "changed" on this map (#42b968, hue 139°), so identity
 * hues from yellow-green to green-teal (60°–170°) move away from it with the same saturation and
 * lightness; a 1 px unchanged border can then never read as a changed one.
 * - Green-teal (110°–170°) lands on teal (172°–180°), mirrored.
 * - Yellow-green and olive (60°–110°) land on a warm brick red (345°–15°), outside the cool
 *   blues and teals that the rest of the palette already uses.
 * Other colours, near-greys and non-hex values pass through unchanged.
 */
export function islandIdentityColor(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16 & 255) / 255, g = (value >> 8 & 255) / 255, b = (value & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), lightness = (max + min) / 2, delta = max - min;
  if (!delta) return color;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue = (max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60;
  if (saturation < .08 || hue < 60 || hue > 170) return color;
  const shifted = hue < 110 ? (345 + (hue - 60) * 30 / 50) % 360 : 172 + (170 - hue) * 8 / 60;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation, x = chroma * (1 - Math.abs((shifted / 60) % 2 - 1)), m = lightness - chroma / 2;
  const sector = Math.floor(shifted / 60);
  const [red, green, blue] = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][sector]!;
  return '#' + [red, green, blue].map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('');
}

/** World-space file pitch of a layout (scaled up for a small repository). */
export function layoutPitch(layout: Pick<GraphLayout, 'islands'>): number {
  return layout.islands.find(island => island.grid)?.grid?.pitch ?? P;
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/** Files a w × h module island holds: a (4w − 2) × (4h − 2) lattice. */
export function islandCapacity(w: number, h: number) { return (4 * w - 2) * (4 * h - 2); }

/**
 * Size tier of an island: the smallest w·h (square, or one module wider than tall) whose
 * lattice holds every file. Pure and monotone in the file count; an empty island is 1 × 1.
 */
export function islandTier(files: number): { w: number; h: number } {
  const need = Math.max(1, files);
  for (let h = 1; ; h++) {
    if (islandCapacity(h, h) >= need) return { w: h, h };
    if (islandCapacity(h + 1, h) >= need) return { w: h + 1, h };
  }
}

/**
 * Dense first-fit packing of module rectangles in input order (CSS grid-auto-flow: dense):
 * each island takes the first free w × h run scanning rows top-down, columns left-to-right.
 */
export function packIslands(tiers: readonly { w: number; h: number }[]): { columns: number; rows: number; cells: { col: number; row: number }[] } {
  const cells = tiers.reduce((total, tier) => total + tier.w * tier.h, 0);
  const columns = Math.max(1, ...tiers.map(tier => tier.w), Math.ceil(Math.sqrt(cells * 2.2)));
  const occupancy: Uint8Array[] = [];
  let firstOpenRow = 0, rows = 0;
  // Returns the column of the first occupied cell in the candidate run, or -1 when it is free.
  const blocked = (col: number, row: number, w: number, h: number) => {
    for (let y = row; y < row + h; y++) {
      const line = occupancy[y]; if (!line) continue;
      for (let x = col + w - 1; x >= col; x--) if (line[x]) return x;
    }
    return -1;
  };
  const placed = tiers.map(({ w, h }) => {
    for (let row = firstOpenRow; ; row++) {
      for (let col = 0; col <= columns - w;) {
        const hit = blocked(col, row, w, h);
        if (hit >= 0) { col = hit + 1; continue; }
        for (let y = row; y < row + h; y++) { const line = occupancy[y] ?? (occupancy[y] = new Uint8Array(columns)); line.fill(1, col, col + w); }
        rows = Math.max(rows, row + h);
        while (occupancy[firstOpenRow] && occupancy[firstOpenRow].every(Boolean)) firstOpenRow++;
        return { col, row };
      }
    }
  });
  return { columns, rows, cells: placed };
}

const entryRank = (path: string) => /(^|\/)refresh\.ts$/.test(path) ? 0 : /(^|\/)handler\.ts$/.test(path) ? 1 : /(^|\/)index\.[cm]?[jt]sx?$/.test(path) ? 2 : 3;

export function layoutGraph(graph: GraphData, options: LayoutOptions = {}): GraphLayout {
  const groups = [...graph.groups].sort((a, b) => a.id.localeCompare(b.id));
  const known = new Set(groups.map(group => group.id));
  if (!known.has('__ungrouped') && graph.nodes.some(node => !known.has(node.groupId))) groups.push({ id: '__ungrouped', label: 'Ungrouped' });
  const grouped = new Map<string, LayoutFile[]>();
  for (const node of graph.nodes) {
    const id = known.has(node.groupId) ? node.groupId : '__ungrouped';
    const list = grouped.get(id) ?? [];
    list.push(node); grouped.set(id, list);
  }
  // Area means files: every island is a rounded rectangle of w × h modules sized by
  // its own file count, packed densely so edges align and small islands fill holes.
  const ordered = groups.map(group => {
    const files = [...(grouped.get(group.id) ?? [])].sort((a, b) => entryRank(a.path) - entryRank(b.path) || a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
    // A non-zero seed rotates the non-entry files through the lattice (deterministically);
    // the application always lays out with seed 0, which keeps the documented order.
    const entries = files.filter(file => entryRank(file.path) < 3).length;
    const rest = files.length - entries;
    if (options.seed && rest > 1) {
      const shift = hashString(`${group.id}:${options.seed}`) % rest;
      files.splice(entries, rest, ...files.slice(entries + shift), ...files.slice(entries, entries + shift));
    }
    return { group, files, tier: islandTier(files.length) };
  });
  const packing = packIslands(ordered.map(item => item.tier));
  const blockColumns = ordered.length ? Math.max(...ordered.map((item, i) => packing.cells[i].col + item.tier.w)) : 0;
  // A small repository (the demo) is scaled up uniformly to fill the minimum world, so
  // the showcase is not a small block in the middle of the screen. Large repositories keep
  // the base geometry, and the lattice pitch stays the same for every island of a layout.
  const scale = ordered.length ? Math.min(MAX_SMALL_WORLD_SCALE, Math.max(1, Math.min((MIN_BOUNDS.width - 100) / (blockColumns * U - G), (MIN_BOUNDS.height - 120) / (packing.rows * U - G)))) : 1;
  const u = U * scale, g = G * scale, p = P * scale, inset = (PAD + P / 2) * scale;
  const blockWidth = ordered.length ? blockColumns * u - g : 0;
  const blockHeight = ordered.length ? packing.rows * u - g : 0;
  const width = Math.max(MIN_BOUNDS.width, blockWidth + 100), height = Math.max(MIN_BOUNDS.height, blockHeight + 120);
  // The packed block keeps 50/60 world units of margin and is centred in the world.
  const originX = (width - blockWidth) / 2 - g / 2, originY = (height - blockHeight) / 2 - g / 2;
  const nodes: PositionedFile[] = [];
  const islands = ordered.map(({ group, files, tier }, index): Island => {
    const { col, row } = packing.cells[index];
    const x0 = originX + col * u + g / 2, y0 = originY + row * u + g / 2;
    const rectWidth = tier.w * u - g, rectHeight = tier.h * u - g;
    const columns = 4 * tier.w - 2, rows = 4 * tier.h - 2;
    const usedColumns = Math.max(1, Math.min(files.length, columns)), usedRows = Math.ceil(files.length / usedColumns);
    // Centre the used block inside the lattice so a five-file island is one centred row.
    const offsetColumns = (columns - usedColumns) / 2, offsetRows = Math.max(0, rows - usedRows) / 2;
    const blockX = x0 + inset + offsetColumns * p, blockY = y0 + inset + offsetRows * p;
    const grid: IslandGrid = { originX: blockX - Math.floor(offsetColumns) * p, originY: blockY - Math.floor(offsetRows) * p, columns: usedColumns + 2 * Math.floor(offsetColumns), pitch: p };
    const placed = files.map((node, i): PositionedFile => {
      const position = { ...node, x: blockX + (i % usedColumns) * p, y: blockY + Math.floor(i / usedColumns) * p };
      nodes.push(position); return position;
    });
    return { ...group, x: x0 + rectWidth / 2, y: y0 + rectHeight / 2, rx: rectWidth / 2, ry: rectHeight / 2, color: islandIdentityColor(group.color ?? PALETTE[index % PALETTE.length]), nodes: placed, grid };
  });
  return { nodes, nodeById: new Map(nodes.map(node => [node.id, node])), islands, bounds: { x: 0, y: 0, width, height } };
}

export function selectedMembership(graph: GraphData, selectedSourceIds: readonly string[]): Map<string, number> {
  const selected = new Set(selectedSourceIds);
  const memberships = new Map<string, Set<string>>();
  const add = (fileId: string, sourceId: string) => {
    if (!selected.has(sourceId)) return;
    const entries = memberships.get(fileId) ?? new Set<string>();
    entries.add(sourceId); memberships.set(fileId, entries);
  };
  for (const node of graph.nodes) for (const sourceId of node.sourceIds ?? []) add(node.id, sourceId);
  for (const source of graph.sources ?? []) for (const file of source.files) add(file.fileId, source.id);
  return new Map([...memberships].map(([id, entries]) => [id, entries.size]));
}

/**
 * Preserve the current repository map as source-only files arrive in an overlay.
 * Surviving files keep their coordinates, new files take free slots of their island's lattice
 * and new islands take their freshly packed place. When any surviving island would need more
 * room than its rectangle holds, or a new island's place is taken, the fresh dense packing
 * (`next`) is returned instead: growing or parking islands would run them across their
 * neighbours or off the block, and the fresh packing is exactly the map a direct load shows.
 */
export function preserveLayout(previous: GraphLayout, next: GraphLayout): GraphLayout {
  const previousIslands = new Map(previous.islands.map(island => [island.id, island]));
  const nodes: PositionedFile[] = [];
  const slotKey = (x: number, y: number) => `${Math.round(x * 2)}:${Math.round(y * 2)}`;
  const survivors = next.islands.flatMap(island => { const prior = previousIslands.get(island.id); return prior ? [prior] : []; });
  const gap = G * layoutPitch(previous) / P;
  const collides = (a: Island, b: Island) => Math.abs(a.x - b.x) < a.rx + b.rx + gap && Math.abs(a.y - b.y) < a.ry + b.ry + gap;
  // A new island keeps its freshly packed place when that place is free. When it is taken by a
  // surviving island, the fresh dense packing is returned instead (the same map a direct load
  // shows) rather than parking new islands beside the block.
  const kept: Island[] = [];
  for (const island of next.islands) {
    if (previousIslands.has(island.id)) continue;
    if (survivors.some(other => collides(other, island)) || kept.some(other => collides(other, island))) return next;
    kept.push(island);
  }
  let overflow = false;
  const islands = next.islands.map(island => {
    const prior = previousIslands.get(island.id);
    if (!prior) { nodes.push(...island.nodes); return island; }
    const survives = (node: PositionedFile) => { const old = previous.nodeById.get(node.id); return old && old.groupId === node.groupId ? old : undefined; };
    const taken = new Set(island.nodes.flatMap(node => { const old = survives(node); return old ? [slotKey(old.x, old.y)] : []; }));
    const grid = prior.grid ?? { originX: prior.x - prior.rx + ISLAND_SLOT_INSET, originY: prior.y - prior.ry + ISLAND_SLOT_INSET, columns: Math.max(1, Math.floor((prior.rx * 2 - PAD * 2) / P)), pitch: P };
    const inset = ISLAND_SLOT_INSET * grid.pitch / P;
    let slot = 0;
    const right = prior.x + prior.rx + 1e-6, bottom = prior.y + prior.ry + 1e-6;
    const placed = island.nodes.map(node => {
      const old = survives(node);
      if (old) return { ...node, x: old.x, y: old.y };
      // A new file takes the next free lattice slot without moving any existing file.
      let x: number, y: number;
      do { x = grid.originX + (slot % grid.columns) * grid.pitch; y = grid.originY + Math.floor(slot / grid.columns) * grid.pitch; slot++; } while (taken.has(slotKey(x, y)));
      taken.add(slotKey(x, y));
      if (x + inset > right || y + inset > bottom) overflow = true;
      return { ...node, x, y };
    });
    nodes.push(...placed); return { ...island, x: prior.x, y: prior.y, rx: prior.rx, ry: prior.ry, nodes: placed, grid };
  });
  // Past an island's capacity the whole map is re-packed; a camera resting at Fit all follows it.
  if (overflow) return next;
  const newGroups = islands.some(island => !previousIslands.has(island.id));
  const minX = Math.min(previous.bounds.x, ...islands.map(island => island.x - island.rx - 50));
  const minY = Math.min(previous.bounds.y, ...islands.map(island => island.y - island.ry - 60));
  const bounds = newGroups ? {
    x: minX, y: minY,
    width: Math.max(previous.bounds.x + previous.bounds.width, ...islands.map(island => island.x + island.rx + 50)) - minX,
    height: Math.max(previous.bounds.y + previous.bounds.height, ...islands.map(island => island.y + island.ry + 60)) - minY,
  } : previous.bounds;
  return { nodes, nodeById: new Map(nodes.map(node => [node.id, node])), islands, bounds };
}

export function neighborsOf(edges: readonly LayoutEdge[], fileId: string | null): Set<string> {
  const neighbors = new Set<string>();
  if (!fileId) return neighbors;
  for (const edge of edges) {
    if (edge.source === fileId) neighbors.add(edge.target);
    if (edge.target === fileId) neighbors.add(edge.source);
  }
  return neighbors;
}

export function fitCamera(bounds: Bounds, width: number, height: number, padding = 22): Camera {
  const zoom = Math.min((width - padding * 2) / Math.max(1, bounds.width), (height - padding * 2) / Math.max(1, bounds.height));
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: Math.max(.01, zoom) };
}
export function screenToWorld(point: Point, camera: Camera, width: number, height: number): Point {
  return { x: (point.x - width / 2) / camera.zoom + camera.x, y: (point.y - height / 2) / camera.zoom + camera.y };
}
export function worldToScreen(point: Point, camera: Camera, width: number, height: number): Point {
  return { x: (point.x - camera.x) * camera.zoom + width / 2, y: (point.y - camera.y) * camera.zoom + height / 2 };
}
export function zoomAt(camera: Camera, zoom: number, anchor: Point, width: number, height: number): Camera {
  const point = screenToWorld(anchor, camera, width, height);
  return { x: point.x - (anchor.x - width / 2) / zoom, y: point.y - (anchor.y - height / 2) / zoom, zoom };
}
export function islandBounds(island: Island): Bounds {
  return { x: island.x - island.rx - 30, y: island.y - island.ry - 35, width: island.rx * 2 + 60, height: island.ry * 2 + 70 };
}
