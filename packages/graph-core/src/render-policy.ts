import type { Bounds, Camera, GraphData, Point } from './index';

/** A measured target, not an input cap: source facts remain complete above it. */
export const GRAPH_ENVELOPE = Object.freeze({ files: 2_000, edges: 8_000 });
export const GRAPH_BUDGETS = Object.freeze({ firstUsefulMs: 2_000, selectionP95Ms: 250, hoverP95Ms: 100, panP95Ms: 33, layoutLongTaskMs: 100 });

export function exceedsGraphEnvelope(graph: Pick<GraphData, 'nodes' | 'edges'>) {
  return graph.nodes.length > GRAPH_ENVELOPE.files || graph.edges.length > GRAPH_ENVELOPE.edges;
}

export function viewportBounds(camera: Camera, width: number, height: number, paddingPx = 0): Bounds {
  const zoom = Math.max(.0001, camera.zoom);
  return { x: camera.x - (width / 2 + paddingPx) / zoom, y: camera.y - (height / 2 + paddingPx) / zoom, width: (width + paddingPx * 2) / zoom, height: (height + paddingPx * 2) / zoom };
}

export function boundsIntersect(a: Bounds, b: Bounds) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

/** Conservative AABB culling keeps lines crossing the viewport with both ends outside. */
export function connectionInViewport(from: Point, to: Point, viewport: Bounds, curvePadding = 25) {
  return boundsIntersect(viewport, { x: Math.min(from.x, to.x) - curvePadding, y: Math.min(from.y, to.y) - curvePadding, width: Math.abs(from.x - to.x) + curvePadding * 2, height: Math.abs(from.y - to.y) + curvePadding * 2 });
}

export function scopeSummary(graph: Pick<GraphData, 'nodes' | 'edges'>, groupId: string | null) {
  if (!groupId) return { files: graph.nodes.length, edges: graph.edges.length, totalFiles: graph.nodes.length, totalEdges: graph.edges.length };
  const ids = new Set(graph.nodes.filter(node => node.groupId === groupId).map(node => node.id));
  return { files: ids.size, edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).length, totalFiles: graph.nodes.length, totalEdges: graph.edges.length };
}
