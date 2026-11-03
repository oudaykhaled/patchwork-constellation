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
export interface Island extends LayoutGroup, Point {
  rx: number; ry: number; nodes: PositionedFile[]; color: string;
}
export interface GraphLayout { nodes: PositionedFile[]; nodeById: Map<string, PositionedFile>; islands: Island[]; bounds: Bounds }

const PALETTE = ['#66BFA0', '#9D8FD4', '#6A9EC7', '#B8A073', '#7796C3', '#839DA0'];
const PRESETS: [RegExp, number, number, number, number][] = [
  [/auth|identity|session/i, 335, 335, 210, 155],
  [/bill|commerce|payment/i, 795, 264, 200, 148],
  [/api|service|backend/i, 786, 586, 200, 155],
  [/interface|frontend|^ui$|experience|web/i, 1280, 428, 206, 153],
  [/shared|common|core|util/i, 350, 700, 190, 135],
  [/infra|config|ops|deploy/i, 1205, 742, 185, 122],
];

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function layoutGraph(graph: GraphData): GraphLayout {
  const groups = [...graph.groups];
  const known = new Set(groups.map(group => group.id));
  if (!known.has('__ungrouped') && graph.nodes.some(node => !known.has(node.groupId))) groups.push({ id: '__ungrouped', label: 'Ungrouped' });
  const grouped = new Map<string, LayoutFile[]>();
  for (const node of graph.nodes) {
    const id = known.has(node.groupId) ? node.groupId : '__ungrouped';
    const list = grouped.get(id) ?? [];
    list.push(node); grouped.set(id, list);
  }
  // Large graphs get more world-space, not larger file circles or hidden files.
  const density = Math.max(1, Math.sqrt(graph.nodes.length / 212));
  const columns = Math.max(1, Math.ceil(Math.sqrt(groups.length * 1.4)));
  const usePresets = groups.length <= 6;
  const usedSlots = new Set<number>();
  const nodes: PositionedFile[] = [];
  const islands = groups.map((group, index): Island => {
    let slot = usePresets ? PRESETS.findIndex(([pattern], i) => pattern.test(group.label) && !usedSlots.has(i)) : -1;
    if (slot < 0 && usePresets) slot = PRESETS.findIndex((_, i) => !usedSlots.has(i));
    if (slot >= 0) usedSlots.add(slot);
    const preset = slot >= 0 ? PRESETS[slot] : undefined;
    const x = (preset ? preset[1] : 280 + (index % columns) * 470) * density;
    const y = (preset ? preset[2] : 320 + Math.floor(index / columns) * 360) * density;
    const rx = (preset ? preset[3] : 205) * density;
    const ry = (preset ? preset[4] : 145) * density;
    const entryRank = (path: string) => /(^|\/)refresh\.ts$/.test(path) ? 0 : /(^|\/)handler\.ts$/.test(path) ? 1 : /(^|\/)index\.[cm]?[jt]sx?$/.test(path) ? 2 : 3;
    const files = [...(grouped.get(group.id) ?? [])].sort((a, b) => entryRank(a.path) - entryRank(b.path) || a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
    const groupSeed = hashString(group.id) / 0xffffffff * Math.PI * 2;
    const placed = files.map((node, i): PositionedFile => {
      const angle = i * 2.399963229728653 + groupSeed;
      const radius = i === 0 ? 0 : Math.sqrt(i / Math.max(1, files.length - 1));
      // Reserve the top quarter for the island label and changed/file counts.
      const position = { ...node, x: x + Math.cos(angle) * radius * rx * .69, y: y + ry * .25 + Math.sin(angle) * radius * ry * .55 };
      nodes.push(position); return position;
    });
    return { ...group, x, y, rx, ry, color: group.color ?? PALETTE[slot >= 0 ? slot : index % PALETTE.length], nodes: placed };
  });
  const minX = Math.min(0, ...islands.map(island => island.x - island.rx - 50));
  const minY = Math.min(0, ...islands.map(island => island.y - island.ry - 60));
  const maxX = Math.max(1600 * density, ...islands.map(island => island.x + island.rx + 50));
  const maxY = Math.max(936 * density, ...islands.map(island => island.y + island.ry + 60));
  return { nodes, nodeById: new Map(nodes.map(node => [node.id, node])), islands, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
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

/** Preserve the current repository map as source-only files arrive in an overlay. */
export function preserveLayout(previous: GraphLayout, next: GraphLayout): GraphLayout {
  const previousIslands = new Map(previous.islands.map(island => [island.id, island]));
  const nodes: PositionedFile[] = [];
  const islands = next.islands.map(island => {
    const prior = previousIslands.get(island.id);
    if (!prior) { nodes.push(...island.nodes); return island; }
    const placed = island.nodes.map(node => {
      const old = previous.nodeById.get(node.id);
      if (old && old.groupId === node.groupId) return { ...node, x: old.x, y: old.y };
      const seed = hashString(node.id), angle = seed / 0xffffffff * Math.PI * 2;
      const radius = .2 + (hashString(node.id + ':radius') / 0xffffffff) * .75;
      return { ...node, x: prior.x + Math.cos(angle) * radius * prior.rx * .69, y: prior.y + prior.ry * .25 + Math.sin(angle) * radius * prior.ry * .55 };
    });
    nodes.push(...placed); return { ...island, x: prior.x, y: prior.y, rx: prior.rx, ry: prior.ry, nodes: placed };
  });
  const newGroups = islands.some(island => !previousIslands.has(island.id));
  const bounds = newGroups ? {
    x: Math.min(previous.bounds.x, next.bounds.x), y: Math.min(previous.bounds.y, next.bounds.y),
    width: Math.max(previous.bounds.x + previous.bounds.width, next.bounds.x + next.bounds.width) - Math.min(previous.bounds.x, next.bounds.x),
    height: Math.max(previous.bounds.y + previous.bounds.height, next.bounds.y + next.bounds.height) - Math.min(previous.bounds.y, next.bounds.y),
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
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: Math.max(.025, zoom) };
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
