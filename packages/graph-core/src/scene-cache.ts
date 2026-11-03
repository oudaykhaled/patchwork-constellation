import type { Camera } from './index';

export const SCENE_CACHE_MAX_PIXELS = 16_000_000;
export const SCENE_CACHE_PADDING = 192;
export interface SceneTile {
  anchor: Camera;
  width: number;
  height: number;
  ratio: number;
  padding: number;
  key: readonly unknown[];
}

/** One bounded backing bitmap. A viewport beyond the cap uses direct rendering. */
export function sceneTile(camera: Camera, width: number, height: number, ratio: number, key: readonly unknown[]): SceneTile | null {
  if (![camera.x, camera.y, camera.zoom, width, height, ratio].every(Number.isFinite) || camera.zoom <= 0 || width <= 0 || height <= 0 || ratio <= 0) return null;
  const padding = SCENE_CACHE_PADDING;
  const pixels = Math.ceil((width + padding * 2) * ratio) * Math.ceil((height + padding * 2) * ratio);
  return pixels <= SCENE_CACHE_MAX_PIXELS ? { anchor: { ...camera }, width, height, ratio, padding, key: [...key] } : null;
}

/** Reuse only a translation of the exact same scene, scale, dimensions and DPR. */
export function sceneTranslation(tile: SceneTile | null, camera: Camera, width: number, height: number, ratio: number, key: readonly unknown[]) {
  if (!tile || tile.width !== width || tile.height !== height || tile.ratio !== ratio || tile.anchor.zoom !== camera.zoom || tile.key.length !== key.length || tile.key.some((value, index) => value !== key[index])) return null;
  const x = (tile.anchor.x - camera.x) * camera.zoom;
  const y = (tile.anchor.y - camera.y) * camera.zoom;
  return Math.abs(x) <= tile.padding && Math.abs(y) <= tile.padding ? { x: x - tile.padding, y: y - tile.padding } : null;
}
