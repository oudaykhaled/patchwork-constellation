import { describe, expect, it } from 'vitest';
import { screenToWorld, worldToScreen } from '../../../../packages/graph-core/src/index';
import { fitVisibleCamera, isValidCamera, minimapPoint, navigationInsets, pinchCamera } from './camera-navigation';

describe('graph camera navigation', () => {
  it('fits the complete bounds between floating controls and a desktop inspector', () => {
    const bounds = { x: 0, y: 0, width: 1600, height: 936 };
    const insets = navigationInsets(1440, 340);
    const camera = fitVisibleCamera(bounds, 1440, 836, insets);
    const topLeft = worldToScreen(bounds, camera, 1440, 836);
    const bottomRight = worldToScreen({ x: 1600, y: 936 }, camera, 1440, 836);
    expect(topLeft.x).toBeGreaterThanOrEqual(insets.left);
    expect(topLeft.y).toBeGreaterThanOrEqual(insets.top);
    expect(bottomRight.x).toBeLessThanOrEqual(1440 - insets.right);
    expect(bottomRight.y).toBeLessThanOrEqual(836 - insets.bottom);
  });
  it('preserves a world anchor while fingers both translate and pinch', () => {
    const before = { x: 800, y: 468, zoom: .7 };
    const oldMidpoint = { x: 470, y: 380 }, newMidpoint = { x: 540, y: 410 };
    const anchor = screenToWorld(oldMidpoint, before, 1440, 836);
    const after = pinchCamera(before, oldMidpoint, newMidpoint, 1.1, 1440, 836);
    expect(worldToScreen(anchor, after, 1440, 836).x).toBeCloseTo(newMidpoint.x);
    expect(worldToScreen(anchor, after, 1440, 836).y).toBeCloseTo(newMidpoint.y);
  });
  it('maps the inner minimap including its edges without padding drift', () => {
    const viewport = { x: 100, y: 200, width: 134, height: 78 };
    const world = { x: -50, y: -20, width: 1600, height: 936 };
    expect(minimapPoint({ x: 100, y: 200 }, viewport, world)).toEqual({ x: -50, y: -20 });
    expect(minimapPoint({ x: 234, y: 278 }, viewport, world)).toEqual({ x: 1550, y: 916 });
    expect(minimapPoint({ x: 500, y: 500 }, viewport, world)).toEqual({ x: 1550, y: 916 });
  });
  it('rejects corrupt saved cameras and keeps a usable narrow map inset', () => {
    expect(isValidCamera({ x: Infinity, y: 0, zoom: 1 })).toBe(false);
    expect(isValidCamera({ x: 0, y: 0, zoom: 0 })).toBe(false);
    expect(isValidCamera({ x: 1, y: 2, zoom: .8 })).toBe(true);
    expect(navigationInsets(390, 340).right).toBe(24);
  });
});
