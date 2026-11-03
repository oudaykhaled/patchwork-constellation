import { describe, expect, it } from 'vitest';
import { SCENE_CACHE_MAX_PIXELS, sceneTile, sceneTranslation } from './scene-cache';

describe('bounded scene bitmap cache', () => {
  const camera = { x: 400, y: 200, zoom: .25 };
  const layout = {}, edges = {}, membership = {};
  const key = [layout, edges, membership, 'selected-file', 'hovered-file', 'search', true, 'scope'];
  it('reuses unchanged geometry at the exact world translation without dropping content', () => {
    const tile = sceneTile(camera, 1600, 936, 2, key)!;
    expect((tile.width + tile.padding * 2) * (tile.height + tile.padding * 2) * tile.ratio ** 2).toBeLessThanOrEqual(SCENE_CACHE_MAX_PIXELS);
    expect(sceneTranslation(tile, { ...camera, x: camera.x + 240, y: camera.y - 80 }, 1600, 936, 2, key)).toEqual({ x: -252, y: -172 });
    expect(sceneTranslation(tile, { ...camera, x: camera.x + 1000 }, 1600, 936, 2, key)).toBeNull();
    expect(tile.anchor).toEqual(camera);
  });
  it('invalidates every factual/highlight/input change and scale/resize/DPR change', () => {
    const tile = sceneTile(camera, 1600, 936, 1, key)!;
    for (let index = 0; index < key.length; index++) {
      const changed = [...key]; changed[index] = {};
      expect(sceneTranslation(tile, camera, 1600, 936, 1, changed)).toBeNull();
    }
    expect(sceneTranslation(tile, { ...camera, zoom: .26 }, 1600, 936, 1, key)).toBeNull();
    expect(sceneTranslation(tile, camera, 1599, 936, 1, key)).toBeNull();
    expect(sceneTranslation(tile, camera, 1600, 936, 2, key)).toBeNull();
  });
  it('bounds allocation and refuses invalid or larger-than-budget buffers', () => {
    expect(sceneTile(camera, 8000, 4000, 2, key)).toBeNull();
    expect(sceneTile(camera, NaN, 936, 1, key)).toBeNull();
    expect(sceneTile({ ...camera, zoom: 0 }, 1600, 936, 1, key)).toBeNull();
  });
});
