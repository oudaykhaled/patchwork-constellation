import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '@patchwork/fixtures';
import { discoverSelectedSources, initialSelection, parseSharedView, sharedViewQuery } from './selection-state';

describe('shared source selection', () => {
  it('distinguishes deliberately empty selection from the default sample', () => {
    const snapshot = createDemoSnapshot();
    expect(initialSelection(snapshot, parseSharedView('?sources=')).ids).toEqual([]);
    expect(initialSelection(snapshot, parseSharedView('')).ids).toHaveLength(3);
    expect(initialSelection(snapshot, parseSharedView('?mode=commit&sources=commit-a81f3c2,commit-a81f3c2')).ids).toEqual(['commit-a81f3c2']);
  });
  it('restores immutable context, source IDs, selected file and finite camera', () => {
    const snapshot = { ...createDemoSnapshot(), mode: 'github' as const };
    const camera = { x: 12.5, y: -36.75, zoom: .75 };
    const query = sharedViewQuery('', snapshot, 'pr', ['pr:90'], snapshot.nodes[0].id, camera);
    const params = new URLSearchParams(query);
    expect(params.get('context')).toBe(snapshot.contextSha);
    expect(parseSharedView(query)).toEqual({ kind: 'pr', sourceIds: ['pr:90'], fileId: snapshot.nodes[0].id, camera });
    expect(parseSharedView('?camera=NaN,3,1').camera).toBeUndefined();
    expect(parseSharedView('?camera=1,2,-1').camera).toBeUndefined();
  });
  it('finds saved sources outside the first discovery page without changing their IDs', async () => {
    const snapshot = createDemoSnapshot();
    const saved = { ...snapshot.sources[0], id: 'pr:old' };
    const pages: number[] = [];
    const sources = await discoverSelectedSources(snapshot, 'pr', [saved.id], async page => {
      pages.push(page);
      return { sources: page === 2 ? [saved] : [], nextPage: page === 1 ? 2 : null };
    }, new AbortController().signal);
    expect(pages).toEqual([1, 2]);
    expect(sources.find(source => source.id === saved.id)).toEqual(saved);
  });
  it('reports inaccessible sources instead of silently restoring unrelated defaults', async () => {
    await expect(discoverSelectedSources(createDemoSnapshot(), 'pr', ['pr:missing'], async () => ({ sources: [], nextPage: null }), new AbortController().signal)).rejects.toThrow('Saved changes are unavailable');
  });
  it('cancels paginated restore before following stale results and bounds requests', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(discoverSelectedSources(createDemoSnapshot(), 'pr', ['pr:missing'], async () => { calls++; controller.abort(); return { sources: [], nextPage: 2 }; }, controller.signal)).rejects.toThrow();
    expect(calls).toBe(1);
    calls = 0;
    await expect(discoverSelectedSources(createDemoSnapshot(), 'pr', ['pr:missing'], async page => { calls++; return { sources: [], nextPage: page + 1 }; }, new AbortController().signal)).rejects.toThrow();
    expect(calls).toBe(10);
  });
});
