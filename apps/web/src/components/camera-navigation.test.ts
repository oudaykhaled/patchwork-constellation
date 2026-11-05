import { describe, expect, it } from 'vitest';
import { screenToWorld, worldToScreen } from '../../../../packages/graph-core/src/index';
import { fitVisibleCamera, isRestorableCamera, isValidCamera, landingWindow, MIN_CAMERA_ZOOM, minimapFrame, minimapPoint, navigationInsets, pinchCamera, sameCamera, visibleWorld } from './camera-navigation';

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
  it('reserves the top band and a one-row bottom bar on desktop, also for large repositories', () => {
    expect(navigationInsets(1920)).toEqual({ top: 120, right: 24, bottom: 80, left: 24 });
    expect(navigationInsets(1440)).toEqual({ top: 120, right: 24, bottom: 80, left: 24 });
    // The strip is one row on desktop; a wrapped strip is measured, not reserved up front.
    expect(navigationInsets(1280)).toEqual({ top: 120, right: 24, bottom: 80, left: 24 });
    expect(navigationInsets(900)).toEqual({ top: 120, right: 24, bottom: 80, left: 24 });
    expect(navigationInsets(390)).toEqual({ top: 196, right: 24, bottom: 150, left: 24 });
  });
  it('fits a very large packed world instead of clamping it at the old 0.025 floor', () => {
    const bounds = { x: 0, y: 0, width: 7000, height: 4000 };
    const camera = fitVisibleCamera(bounds, 1920, 1016, navigationInsets(1920));
    expect(camera.zoom).toBeGreaterThan(MIN_CAMERA_ZOOM);
    expect(worldToScreen({ x: 0, y: 0 }, camera, 1920, 1016).y).toBeGreaterThanOrEqual(120);
    expect(worldToScreen({ x: 7000, y: 4000 }, camera, 1920, 1016).y).toBeLessThanOrEqual(1016 - 80);
    expect(fitVisibleCamera({ x: 0, y: 0, width: 1e6, height: 1e6 }, 390, 786, navigationInsets(390)).zoom).toBe(MIN_CAMERA_ZOOM);
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
  it('ignores a saved camera that no longer frames the layout, such as one from a much larger world', () => {
    // A packed world at 1920 x 1016, its Fit camera and two island rectangles.
    const bounds = { x: 0, y: 0, width: 4000, height: 2000 }, insets = navigationInsets(1920);
    const fit = fitVisibleCamera(bounds, 1920, 1016, insets);
    const islands = [{ x: 50, y: 60, width: 168, height: 72 }, { x: 3600, y: 1800, width: 264, height: 168 }];
    expect(isRestorableCamera(fit, fit, islands, 1920, 1016, insets)).toBe(true);
    expect(isRestorableCamera({ ...fit, zoom: fit.zoom * 3, x: 200, y: 120 }, fit, islands, 1920, 1016, insets)).toBe(true);
    // Cameras saved against a much larger world: one at its Fit zoom and a zoomed-in one.
    expect(isRestorableCamera({ x: 40000, y: 20000, zoom: .025 }, fit, islands, 1920, 1016, insets)).toBe(false);
    expect(isRestorableCamera({ x: 45000, y: 22000, zoom: .08 }, fit, islands, 1920, 1016, insets)).toBe(false);
    // In range but looking at empty world: no island in the visible map.
    expect(isRestorableCamera({ x: 2600, y: 1400, zoom: fit.zoom * 4 }, fit, islands, 1920, 1016, insets)).toBe(false);
    expect(isRestorableCamera({ ...fit, zoom: fit.zoom * 20 }, fit, islands, 1920, 1016, insets)).toBe(false);
    expect(isRestorableCamera(undefined, fit, islands, 1920, 1016, insets)).toBe(false);
    expect(isRestorableCamera({ x: NaN, y: 0, zoom: 1 }, fit, islands, 1920, 1016, insets)).toBe(false);
  });
  it('measures the visible map between the chrome and compares cameras to the pixel', () => {
    const view = visibleWorld({ x: 800, y: 468, zoom: .5 }, 1600, 936, { top: 120, right: 24, bottom: 80, left: 24 });
    expect(view).toEqual({ x: 800 - 776 / .5, y: 468 - 348 / .5, width: 1552 / .5, height: 736 / .5 });
    expect(sameCamera({ x: 10.5, y: 20, zoom: .5 }, { x: 10, y: 20, zoom: .5 })).toBe(true);
    expect(sameCamera({ x: 13, y: 20, zoom: .5 }, { x: 10, y: 20, zoom: .5 })).toBe(false);
    expect(sameCamera({ x: 10, y: 20, zoom: .51 }, { x: 10, y: 20, zoom: .5 })).toBe(false);
  });
  it('lands a phone on the window holding the most changed files in whole islands', () => {
    const rect = (x: number, y: number, weight: number, size = 100) => ({ x, y, width: size, height: size, weight });
    const contains = (outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }) =>
      inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
    // A dense cluster on the right outweighs one heavy island far away on the left; the window is centred on it.
    const cluster = [rect(3000, 1000, 9), rect(3150, 1000, 8), rect(3000, 1150, 7), rect(3300, 1200, 6)];
    const box = landingWindow([rect(0, 0, 20), ...cluster], 600, 500)!;
    expect(box).toEqual({ x: 2900, y: 900, width: 600, height: 500 });
    for (const island of cluster) expect(contains(box, island)).toBe(true);
    // One island larger than the window: centre on the heaviest island.
    expect(landingWindow([rect(0, 0, 3, 900), rect(2000, 0, 5, 900)], 600, 500)).toEqual({ x: 2150, y: 200, width: 600, height: 500 });
    expect(landingWindow([], 600, 500)).toBeUndefined();
  });
  it('slides the landing window off a changed island it would otherwise cut in half', () => {
    const island = (x: number, weight: number, width = 100) => ({ x, y: 0, width, height: 100, weight });
    // The pair (200-400) is heaviest. Centred on it, a 400-wide window (100-500) would cut the wide
    // neighbour (480-780), which cannot fit with the pair. Sliding left to 80-480 keeps the pair whole,
    // cuts nothing and stays as close to centred as that allows.
    const pair = [island(200, 5), island(300, 5)], neighbour = island(480, 2, 300);
    const box = landingWindow([...pair, neighbour], 400, 300)!;
    expect(box).toEqual({ x: 80, y: -100, width: 400, height: 300 });
    const cut = (rect: typeof neighbour) => rect.x < box.x + box.width && rect.x + rect.width > box.x && !(rect.x >= box.x && rect.x + rect.width <= box.x + box.width);
    expect([...pair, neighbour].filter(cut)).toHaveLength(0);
  });
  it('counts a changed island behind the chrome as cut, and slides the window to avoid it', () => {
    const island = (x: number, y: number, weight: number) => ({ x, y, width: 100, height: 100, weight });
    // A 300 × 300 map window with 200 world units of chrome above it (the phone's top band).
    // Centred on the heavy island at (0,0) (window from y -100), the light one at y -380..-280 would sit
    // behind the band (screen top -300). Starting the window at y -80 keeps it off screen instead.
    const heavy = island(0, 0, 9), behind = island(0, -380, 1);
    const box = landingWindow([heavy, behind], 300, 300, { top: 200, right: 0, bottom: 0, left: 0 })!;
    expect(box.y).toBe(-80);
    const onScreen = (rect: typeof heavy) => rect.y < box.y + box.height && rect.y + rect.height > box.y - 200;
    const whole = (rect: typeof heavy) => rect.y >= box.y && rect.y + rect.height <= box.y + box.height;
    expect(whole(heavy)).toBe(true);
    expect(onScreen(behind) && !whole(behind)).toBe(false);
  });
  it('keeps the minimap viewport frame inside the world so it is drawn at Fit', () => {
    const world = { x: 0, y: 0, width: 1200, height: 760 }, pixels = { width: 120, height: 76 };
    // At Fit the canvas sees more than the world on every side: the frame hugs the border, inset 0.75 px.
    expect(minimapFrame({ x: -300, y: -200, width: 1800, height: 1160 }, world, pixels)).toEqual({ x: 7.5, y: 7.5, width: 1185, height: 745 });
    // Zoomed in, the frame is the view itself.
    expect(minimapFrame({ x: 100, y: 200, width: 300, height: 150 }, world, pixels)).toEqual({ x: 100, y: 200, width: 300, height: 150 });
    // Panned off the right edge: a sliver at that edge, never nothing.
    const off = minimapFrame({ x: 5000, y: 100, width: 300, height: 150 }, world, pixels);
    expect(off.x + off.width).toBeCloseTo(1192.5, 9); expect(off.width).toBeGreaterThan(0);
  });
  it('rejects corrupt saved cameras and keeps a usable narrow map inset', () => {
    expect(isValidCamera({ x: Infinity, y: 0, zoom: 1 })).toBe(false);
    expect(isValidCamera({ x: 0, y: 0, zoom: 0 })).toBe(false);
    expect(isValidCamera({ x: 1, y: 2, zoom: .8 })).toBe(true);
    expect(navigationInsets(390, 340).right).toBe(24);
  });
});
