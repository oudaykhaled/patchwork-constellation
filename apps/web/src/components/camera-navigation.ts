import type { Bounds, Camera, Point } from '../../../../packages/graph-core/src/index';
import { screenToWorld } from '../../../../packages/graph-core/src/index';

export interface ViewportInsets { top: number; right: number; bottom: number; left: number }
export const MIN_RELATIVE_ZOOM = .32;
export const MAX_RELATIVE_ZOOM = 8;

/** Reserve a usable rectangle between the top control band (source bar + search,
 * then the one-line heading/status strip) and the bottom bar (legend, scope, zoom).
 * The bar is one row on desktop: below 1500 px the Explore scope cluster collapses to
 * its select, so large repositories need no taller bar. A narrow inspector is
 * intentionally dismissible rather than reducing the map to a few pixels. Desktop
 * inspectors reserve their measured width; a bar that still wraps is measured. */
export function navigationInsets(width: number, inspectorWidth = 0): ViewportInsets {
  return {
    top: width <= 760 ? 196 : width <= 1380 ? 150 : 120,
    right: width > 900 && inspectorWidth ? inspectorWidth + 40 : 24,
    bottom: width <= 760 ? 150 : 80,
    left: 24,
  };
}

/** Lowest camera zoom; packed rectangles fit very large repositories well above it. */
export const MIN_CAMERA_ZOOM = .01;

export function fitVisibleCamera(bounds: Bounds, width: number, height: number, insets: ViewportInsets, padding = 12): Camera {
  const availableWidth = Math.max(64, width - insets.left - insets.right);
  const availableHeight = Math.max(64, height - insets.top - insets.bottom);
  const zoom = Math.max(MIN_CAMERA_ZOOM, Math.min(Math.max(1, availableWidth - padding * 2) / Math.max(1, bounds.width), Math.max(1, availableHeight - padding * 2) / Math.max(1, bounds.height)));
  const center = { x: insets.left + availableWidth / 2, y: insets.top + availableHeight / 2 };
  return { x: bounds.x + bounds.width / 2 - (center.x - width / 2) / zoom, y: bounds.y + bounds.height / 2 - (center.y - height / 2) / zoom, zoom };
}

export function isValidCamera(value: Camera | undefined): value is Camera {
  return !!value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.zoom) && value.zoom > 0;
}

/** The map area between the chrome insets, in world coordinates. */
export function visibleWorld(camera: Camera, width: number, height: number, insets: ViewportInsets): Bounds {
  const topLeft = screenToWorld({ x: insets.left, y: insets.top }, camera, width, height);
  return { x: topLeft.x, y: topLeft.y, width: Math.max(0, width - insets.left - insets.right) / camera.zoom, height: Math.max(0, height - insets.top - insets.bottom) / camera.zoom };
}

/** The zoom range navigation allows for a layout whose Fit all zoom is `fitZoom`. */
export function zoomRange(fitZoom: number) { return { min: fitZoom * MIN_RELATIVE_ZOOM, max: Math.max(4.8, fitZoom * MAX_RELATIVE_ZOOM) }; }

/**
 * A saved camera (shared link, saved view, reloaded tab) is restored only while it still frames
 * this layout: its zoom lies in the range navigation allows around Fit all, and at least one
 * island is inside the visible map. A camera recorded against another layout — the earlier organic-island worlds were
 * much larger — fails, and the map lands as if no camera had been saved.
 */
export function isRestorableCamera(camera: Camera | undefined, fit: Camera, targets: readonly Bounds[], width: number, height: number, insets: ViewportInsets): camera is Camera {
  if (!isValidCamera(camera) || !isValidCamera(fit)) return false;
  const { min, max } = zoomRange(fit.zoom);
  if (camera.zoom < min * (1 - 1e-6) || camera.zoom > max * (1 + 1e-6)) return false;
  const view = visibleWorld(camera, width, height, insets);
  return targets.some(rect => rect.x < view.x + view.width && rect.x + rect.width > view.x && rect.y < view.y + view.height && rect.y + rect.height > view.y);
}

/** True when two cameras show the same picture to within a pixel. */
export function sameCamera(a: Camera, b: Camera): boolean {
  return Math.abs(a.zoom - b.zoom) <= b.zoom * 1e-3 && Math.abs(a.x - b.x) * b.zoom <= 1 && Math.abs(a.y - b.y) * b.zoom <= 1;
}

/**
 * Where a phone lands on a large repository: a window of the visible map's size (world units)
 * that, in order, (1) maximises the changed files in islands it contains completely minus the
 * changed files in islands it cuts — on screen but not wholly inside it, crossing its edge or
 * behind the chrome (`chrome` gives the on-screen margins around the window, in world units) —
 * (2) then holds the most, and (3) is the most centred on the islands it holds. Returned as the
 * window itself, for the camera to centre on. Undefined without targets; centred on the heaviest
 * target when no target fits the window.
 */
export function landingWindow(targets: readonly (Bounds & { weight: number })[], width: number, height: number, chrome: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0 }): Bounds | undefined {
  if (!targets.length) return undefined;
  // Bounded work: the heaviest 160 targets are scored; window and screen edges are aligned with the
  // edges of the heaviest 40 (just inside or just outside each), ~9M checks at most.
  const all = [...targets].sort((a, b) => b.weight - a.weight).slice(0, 160);
  const xs = new Set<number>(), ys = new Set<number>();
  for (const rect of all.slice(0, 40)) {
    for (const x of [rect.x, rect.x + rect.width, rect.x - width, rect.x + rect.width - width, rect.x + rect.width + chrome.left, rect.x - width - chrome.right]) xs.add(x);
    for (const y of [rect.y, rect.y + rect.height, rect.y - height, rect.y + rect.height - height, rect.y + rect.height + chrome.top, rect.y - height - chrome.bottom]) ys.add(y);
  }
  type Score = { contained: number; cut: number; offset: number; x: number; y: number };
  const score = (x: number, y: number): Score | undefined => {
    const left = x - chrome.left, top = y - chrome.top, right = x + width + chrome.right, bottom = y + height + chrome.bottom;
    let contained = 0, cut = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const rect of all) {
      if (rect.x >= x && rect.y >= y && rect.x + rect.width <= x + width && rect.y + rect.height <= y + height) {
        contained += rect.weight;
        minX = Math.min(minX, rect.x); minY = Math.min(minY, rect.y); maxX = Math.max(maxX, rect.x + rect.width); maxY = Math.max(maxY, rect.y + rect.height);
      } else if (rect.x < right && rect.x + rect.width > left && rect.y < bottom && rect.y + rect.height > top) cut += rect.weight;
    }
    return contained ? { contained, cut, offset: Math.hypot((minX + maxX) / 2 - (x + width / 2), (minY + maxY) / 2 - (y + height / 2)), x, y } : undefined;
  };
  const better = (a: Score, b?: Score) => !b || a.contained - a.cut > b.contained - b.cut || (a.contained - a.cut === b.contained - b.cut && (a.contained > b.contained || (a.contained === b.contained && a.offset < b.offset - 1e-9)));
  let best: Score | undefined;
  for (const x of xs) for (const y of ys) { const candidate = score(x, y); if (candidate && better(candidate, best)) best = candidate; }
  if (!best) { const rect = all[0]; return { x: rect.x + rect.width / 2 - width / 2, y: rect.y + rect.height / 2 - height / 2, width, height }; }
  // Centre on what it holds, on both axes or on one, when that keeps the same islands whole and cuts no more.
  const chosen = best;
  const held = all.filter(rect => rect.x >= chosen.x && rect.y >= chosen.y && rect.x + rect.width <= chosen.x + width && rect.y + rect.height <= chosen.y + height);
  const centreX = (Math.min(...held.map(rect => rect.x)) + Math.max(...held.map(rect => rect.x + rect.width))) / 2 - width / 2;
  const centreY = (Math.min(...held.map(rect => rect.y)) + Math.max(...held.map(rect => rect.y + rect.height))) / 2 - height / 2;
  for (const [x, y] of [[centreX, centreY], [chosen.x, centreY], [centreX, chosen.y]]) {
    const candidate = score(x, y);
    if (candidate && candidate.contained >= chosen.contained && candidate.cut <= chosen.cut && candidate.offset < best.offset - 1e-9) best = candidate;
  }
  return { x: best.x, y: best.y, width, height };
}

/** Two-finger translation and scale keep the same world point beneath the
 * gesture midpoint, even when the fingers move together without scaling. */
export function pinchCamera(camera: Camera, oldMidpoint: Point, newMidpoint: Point, nextZoom: number, width: number, height: number): Camera {
  const anchor = screenToWorld(oldMidpoint, camera, width, height);
  return { x: anchor.x - (newMidpoint.x - width / 2) / nextZoom, y: anchor.y - (newMidpoint.y - height / 2) / nextZoom, zoom: nextZoom };
}

/** Minimap coordinates use the inner SVG, excluding the button border/padding. */
export function minimapPoint(point: Point, viewport: Bounds, world: Bounds): Point {
  const fraction = (value: number) => Math.max(0, Math.min(1, value));
  return { x: world.x + fraction((point.x - viewport.x) / Math.max(1, viewport.width)) * world.width, y: world.y + fraction((point.y - viewport.y) / Math.max(1, viewport.height)) * world.height };
}

/**
 * The minimap's viewport frame, clamped inside the world (the SVG viewBox) by 0.75 px of the
 * minimap's drawing size, so its 1.25 px stroke is always visible: at Fit the canvas shows more
 * than the world and an unclamped frame would sit outside the SVG and be clipped away. A view
 * entirely off one side keeps a sliver at that edge.
 */
export function minimapFrame(view: Bounds, world: Bounds, pixels: { width: number; height: number }): Bounds {
  const insetX = .75 * world.width / Math.max(1, pixels.width), insetY = .75 * world.height / Math.max(1, pixels.height);
  const clampTo = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  const left = world.x + insetX, right = world.x + world.width - insetX, top = world.y + insetY, bottom = world.y + world.height - insetY;
  let x0 = clampTo(view.x, left, right), x1 = clampTo(view.x + view.width, left, right);
  let y0 = clampTo(view.y, top, bottom), y1 = clampTo(view.y + view.height, top, bottom);
  if (x1 - x0 < insetX) { x0 = Math.min(x0, right - insetX); x1 = x0 + insetX; }
  if (y1 - y0 < insetY) { y0 = Math.min(y0, bottom - insetY); y1 = y0 + insetY; }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
