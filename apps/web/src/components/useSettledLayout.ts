import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { layoutKey, startLayoutTask } from '../../../../packages/graph-core/src/layout-task';
import type { GraphData, GraphLayout, Point } from '../../../../packages/graph-core/src/index';
import type { LayoutWorkerPort } from '../../../../packages/graph-core/src/layout-task';

const EMPTY_LAYOUT: GraphLayout = { nodes: [], nodeById: new Map(), islands: [], bounds: { x: 0, y: 0, width: 1600, height: 936 } };
type Snapshot = GraphData & { id?: string; repository?: { fullName: string }; mode?: string };

/** Settled revision layouts are cached for undo; highlights never enter the key. */
export function useSettledLayout(snapshot: Snapshot, seed = 0, pins?: Record<string, Point>) {
  const repository = snapshot.repository ? `${snapshot.mode ?? ''}:${snapshot.repository.fullName}` : snapshot.id ?? 'graph';
  const structure = useMemo(() => layoutKey(snapshot, seed), [snapshot.nodes, snapshot.groups, seed]);
  const pinKey = JSON.stringify(Object.entries(pins ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const key = `${repository}:${structure}:${pinKey}`;
  const current = useRef({ snapshot, pins }); current.current = { snapshot, pins };
  const cache = useRef(new Map<string, GraphLayout>());
  const previous = useRef<{ repository: string; seed: number; layout: GraphLayout } | null>(null);
  const sequence = useRef(0);
  const [layout, setLayout] = useState(EMPTY_LAYOUT);
  const [state, setState] = useState<'pending' | 'ready' | 'failed'>('pending');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const resetLayout = useCallback(() => { cache.current.delete(key); previous.current = null; setRetry(value => value + 1); }, [key]);

  useEffect(() => {
    const cached = cache.current.get(key);
    if (cached) { previous.current = { repository, seed, layout: cached }; setLayout(cached); setState('ready'); setError(''); return; }
    const controller = new AbortController();
    const id = ++sequence.current;
    setState('pending'); setError('');
    // A different repository must never display the preceding repository map.
    if (previous.current?.repository !== repository) setLayout(EMPTY_LAYOUT);
    let worker: Worker;
    try { worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module', name: 'constellation-layout' }); }
    catch { setState('failed'); setError('Layout worker is unavailable. Use Files or retry.'); return; }
    const data = current.current;
    void startLayoutTask(worker as unknown as LayoutWorkerPort, {
      id,
      // Edges and source selections are presentation overlays, not layout input.
      graph: { nodes: data.snapshot.nodes.map(({ id: fileId, path, groupId }) => ({ id: fileId, path, groupId })), groups: data.snapshot.groups, edges: [] },
      seed, pins: data.pins,
      previous: previous.current?.repository === repository && previous.current.seed === seed ? previous.current.layout : undefined,
    }, controller.signal).then(result => {
      if (controller.signal.aborted || id !== sequence.current) return;
      cache.current.set(key, result);
      // Bound revision history: cache is an optimization, not durable state.
      while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
      previous.current = { repository, seed, layout: result };
      setLayout(result); setState('ready');
    }).catch(reason => {
      if (controller.signal.aborted || id !== sequence.current) return;
      setState('failed'); setError(reason instanceof Error ? reason.message : 'Layout failed. Use Files or retry.');
    });
    return () => controller.abort();
  }, [key, repository, seed, retry]);

  return { layout, layoutState: state, layoutError: error, resetLayout };
}
