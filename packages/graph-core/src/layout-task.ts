import { layoutGraph, preserveLayout } from './index';
import type { GraphData, GraphLayout, Point } from './index';

export interface LayoutTask {
  id: number;
  graph: GraphData;
  seed?: number;
  previous?: GraphLayout;
  pins?: Record<string, Point>;
}
export type LayoutReply = { id: number; layout: GraphLayout } | { id: number; error: string };

/** Only structural facts participate. Source overlays cannot start layout work. */
export function layoutKey(graph: GraphData, seed = 0): string {
  const files = graph.nodes.map(node => `${node.id}\0${node.path}\0${node.groupId}`).sort();
  const groups = graph.groups.map(group => `${group.id}\0${group.label}\0${group.color ?? ''}`).sort();
  return JSON.stringify([seed, files, groups]);
}

/** Reviewable world-space deltas for a grouping preview, before installing it. */
export function previewLayoutChanges(previous: GraphLayout, proposed: GraphLayout) {
  return proposed.nodes.flatMap(node => {
    const before = previous.nodeById.get(node.id);
    if (!before || before.groupId === node.groupId) return [];
    return [{ fileId: node.id, fromGroupId: before.groupId, toGroupId: node.groupId, before: { x: before.x, y: before.y }, after: { x: node.x, y: node.y } }];
  });
}

/** A bounded, settled task. Cancellation terminates its dedicated worker. */
export function executeLayoutTask(task: LayoutTask): GraphLayout {
  const computed = layoutGraph(task.graph, { seed: task.seed });
  const layout = task.previous ? preserveLayout(task.previous, computed) : computed;
  if (!task.pins || !Object.keys(task.pins).length) return layout;
  const nodes = layout.nodes.map(node => {
    const pin = task.pins?.[node.id];
    return pin && Number.isFinite(pin.x) && Number.isFinite(pin.y) ? { ...node, x: pin.x, y: pin.y } : node;
  });
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const islands = layout.islands.map(island => {
    const placed = island.nodes.map(node => nodeById.get(node.id)!);
    // Pins are world-space positions. Expand the hull instead of letting a
    // pinned file escape its island; do not move any surviving file.
    const rx = Math.max(island.rx, ...placed.map(node => Math.abs(node.x - island.x) / .69 + 16));
    const ry = Math.max(island.ry, ...placed.map(node => Math.abs(node.y - island.y) / .7 + 16));
    return { ...island, rx, ry, nodes: placed };
  });
  const minX = Math.min(layout.bounds.x, ...islands.map(island => island.x - island.rx - 50));
  const minY = Math.min(layout.bounds.y, ...islands.map(island => island.y - island.ry - 60));
  const maxX = Math.max(layout.bounds.x + layout.bounds.width, ...islands.map(island => island.x + island.rx + 50));
  const maxY = Math.max(layout.bounds.y + layout.bounds.height, ...islands.map(island => island.y + island.ry + 60));
  return { nodes, nodeById, islands, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}

export interface LayoutWorkerPort {
  postMessage(task: LayoutTask): void;
  terminate(): void;
  onmessage: ((event: { data: LayoutReply }) => void) | null;
  onerror: ((event: { message?: string; preventDefault?: () => void }) => void) | null;
  onmessageerror?: ((event: unknown) => void) | null;
}

/** One active task, no queue. Late/failed workers can never install old maps. */
export function startLayoutTask(worker: LayoutWorkerPort, task: LayoutTask, signal: AbortSignal, timeoutMs = 15_000): Promise<GraphLayout> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error, layout?: GraphLayout) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error); else resolve(layout!);
    };
    const abort = () => finish(new DOMException('Layout cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Layout worker timed out. Use Files or retry.')), timeoutMs);
    worker.onmessage = event => {
      if (event.data.id !== task.id) return;
      if ('error' in event.data) finish(new Error(event.data.error));
      else finish(undefined, event.data.layout);
    };
    worker.onerror = event => { event.preventDefault?.(); finish(new Error('Layout worker failed. Use Files or retry.')); };
    worker.onmessageerror = () => finish(new Error('Layout response could not be read. Use Files or retry.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { worker.postMessage(task); } catch { finish(new Error('Layout could not start. Use Files or retry.')); }
  });
}
