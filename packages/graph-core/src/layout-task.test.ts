import { describe, expect, it, vi } from 'vitest';
import { createDemoSnapshot } from '../../fixtures/src/index';
import { executeLayoutTask, layoutKey, previewLayoutChanges, startLayoutTask } from './layout-task';
import type { LayoutReply, LayoutTask, LayoutWorkerPort } from './layout-task';

class FakeWorker implements LayoutWorkerPort {
  onmessage: ((event: { data: LayoutReply }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  postMessage = vi.fn<(task: LayoutTask) => void>();
  terminate = vi.fn();
}
const graph = createDemoSnapshot();

describe('settled worker layout protocol', () => {
  it('excludes source selections, memberships, and source order from the task key', () => {
    expect(layoutKey(graph)).toBe(layoutKey({ ...graph, nodes: graph.nodes.map(node => ({ ...node, sourceIds: [] })), sources: [] }));
    expect(layoutKey(graph)).toBe(layoutKey({ ...graph, nodes: [...graph.nodes].reverse(), groups: [...graph.groups].reverse() }));
    expect(layoutKey(graph, 1)).not.toBe(layoutKey(graph, 2));
  });
  it('settles deterministically for a seed and independently of group/input order', () => {
    const first = executeLayoutTask({ id: 1, graph, seed: 77 });
    const second = executeLayoutTask({ id: 2, graph: { ...graph, groups: [...graph.groups].reverse(), nodes: [...graph.nodes].reverse() }, seed: 77 });
    expect(second).toEqual(first);
    expect(executeLayoutTask({ id: 3, graph, seed: 78 }).nodes).not.toEqual(first.nodes);
  });
  it('keeps surviving coordinates on refresh, removes deleted IDs, and adds new files', () => {
    const previous = executeLayoutTask({ id: 1, graph });
    const nextGraph = { ...graph, nodes: [...graph.nodes.slice(1), { id: 'new', path: 'src/auth/new.ts', groupId: graph.nodes[1].groupId }] };
    const next = executeLayoutTask({ id: 2, graph: nextGraph, previous });
    expect(next.nodeById.has(graph.nodes[0].id)).toBe(false);
    expect(next.nodeById.has('new')).toBe(true);
    for (const file of graph.nodes.slice(1)) {
      expect(next.nodeById.get(file.id)?.x).toBe(previous.nodeById.get(file.id)?.x);
      expect(next.nodeById.get(file.id)?.y).toBe(previous.nodeById.get(file.id)?.y);
    }
  });
  it('preserves explicit pins while expanding their containing island and world bounds', () => {
    const file = graph.nodes[0];
    const layout = executeLayoutTask({ id: 1, graph, pins: { [file.id]: { x: -200, y: -400 } } });
    expect(layout.nodeById.get(file.id)).toMatchObject({ x: -200, y: -400 });
    const island = layout.islands.find(group => group.id === file.groupId)!;
    expect(Math.abs(-200 - island.x)).toBeLessThan(island.rx);
    expect(Math.abs(-400 - island.y)).toBeLessThan(island.ry);
    expect(layout.bounds.x).toBeLessThan(-200); expect(layout.bounds.y).toBeLessThan(-400);
  });
  it('previews a regrouped file and positions a new island outside surviving hulls', () => {
    const before = executeLayoutTask({ id: 1, graph });
    const nextGraph = { ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, groupId: 'new-island' } : node), groups: [...graph.groups, { id: 'new-island', label: 'New island' }] };
    const after = executeLayoutTask({ id: 2, graph: nextGraph, previous: before });
    const delta = previewLayoutChanges(before, after);
    expect(delta).toHaveLength(1); expect(delta[0]).toMatchObject({ fileId: graph.nodes[0].id, toGroupId: 'new-island' });
    const added = after.islands.find(island => island.id === 'new-island')!;
    for (const island of after.islands.filter(island => island.id !== 'new-island')) expect(Math.abs(added.x - island.x) > added.rx + island.rx || Math.abs(added.y - island.y) > added.ry + island.ry).toBe(true);
    expect(after.bounds.x + after.bounds.width).toBeGreaterThan(added.x + added.rx);
  });
  it('handles giant, tiny, empty and disconnected islands without swallowing another island', () => {
    const giant = { nodes: Array.from({ length: 2000 }, (_, id) => ({ id: String(id), path: `giant/${id}.ts`, groupId: 'giant' })).concat({ id: 'single', path: 'tiny.ts', groupId: 'tiny' }), groups: [{ id: 'giant', label: 'Giant' }, { id: 'tiny', label: 'Tiny' }, { id: 'empty', label: 'Empty' }], edges: [] };
    const layout = executeLayoutTask({ id: 1, graph: giant });
    expect(layout.nodes).toHaveLength(2001); expect(layout.islands).toHaveLength(3);
    for (const island of layout.islands) {
      for (const file of island.nodes) { expect(Math.abs(file.x - island.x)).toBeLessThan(island.rx); expect(Math.abs(file.y - island.y)).toBeLessThan(island.ry); }
      for (const other of layout.islands) if (other.id !== island.id) expect(Math.abs(island.x - other.x)).toBeGreaterThan(island.rx + other.rx);
    }
  });
  it('cancels by terminating the worker and detaching callbacks', async () => {
    const worker = new FakeWorker(), controller = new AbortController();
    const result = startLayoutTask(worker, { id: 1, graph }, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(worker.onmessage).toBeNull(); expect(worker.onerror).toBeNull();
  });
  it('never starts an already canceled request', async () => {
    const worker = new FakeWorker(), controller = new AbortController(); controller.abort();
    await expect(startLayoutTask(worker, { id: 1, graph }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.postMessage).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('ignores stale worker replies and terminates after the matching settled map', async () => {
    const worker = new FakeWorker(), layout = executeLayoutTask({ id: 2, graph });
    const result = startLayoutTask(worker, { id: 2, graph }, new AbortController().signal);
    worker.onmessage!({ data: { id: 1, layout } }); expect(worker.terminate).not.toHaveBeenCalled();
    worker.onmessage!({ data: { id: 2, layout } });
    await expect(result).resolves.toEqual(layout); expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('reports worker faults and timeouts as recoverable failures', async () => {
    const crashed = new FakeWorker();
    const result = startLayoutTask(crashed, { id: 1, graph }, new AbortController().signal);
    crashed.onerror!({ message: 'untrusted provider payload must not leak' });
    await expect(result).rejects.toThrow('Layout worker failed. Use Files or retry.');
    const timedOut = new FakeWorker();
    await expect(startLayoutTask(timedOut, { id: 1, graph }, new AbortController().signal, 5)).rejects.toThrow('timed out');
    expect(timedOut.terminate).toHaveBeenCalledOnce();
  });
});
