import { describe, expect, it } from 'vitest';
import { createScaleFixture } from '@patchwork/fixtures';
import { boundsIntersect, connectionInViewport, exceedsGraphEnvelope, scopeSummary, viewportBounds } from './render-policy';

describe('render bounds and explicitly scoped detail', () => {
  it('retains crossing connections even when both endpoints are offscreen', () => {
    const viewport = viewportBounds({ x: 0, y: 0, zoom: 2 }, 400, 200);
    expect(connectionInViewport({ x: -900, y: 0 }, { x: 900, y: 0 }, viewport)).toBe(true);
    expect(connectionInViewport({ x: -900, y: -500 }, { x: -600, y: -400 }, viewport)).toBe(false);
    expect(connectionInViewport({ x: -125, y: 0 }, { x: -125, y: 10 }, viewport)).toBe(true);
    expect(boundsIntersect(viewport, { x: 100, y: 0, width: 20, height: 20 })).toBe(true);
  });
  it('maps screen padding to world units at any camera zoom', () => {
    expect(viewportBounds({ x: 50, y: 50, zoom: 2 }, 400, 200, 20)).toEqual({ x: -60, y: -10, width: 220, height: 120 });
  });
  it('preserves full counts when filtering one island in a stress fixture', () => {
    const graph = createScaleFixture(10_000, 40_000, 42);
    const copy = JSON.stringify(graph);
    expect(exceedsGraphEnvelope(graph)).toBe(true);
    expect(exceedsGraphEnvelope(createScaleFixture(2_000, 8_000, 42))).toBe(false);
    const scope = scopeSummary(graph, graph.groups[0].id);
    expect(scope.files).toBeGreaterThan(0);
    expect(scope.files).toBeLessThan(10_000);
    expect(scope.edges).toBeLessThan(40_000);
    expect(scope.totalFiles).toBe(10_000);
    expect(scopeSummary(graph, null)).toEqual({ files: 10_000, edges: 40_000, totalFiles: 10_000, totalEdges: 40_000 });
    expect(JSON.stringify(graph)).toBe(copy);
  });
});
