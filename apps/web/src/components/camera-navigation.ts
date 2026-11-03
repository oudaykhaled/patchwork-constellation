import type { Bounds, Camera, Point } from '../../../../packages/graph-core/src/index';
import { screenToWorld } from '../../../../packages/graph-core/src/index';

export interface ViewportInsets { top: number; right: number; bottom: number; left: number }
export const MIN_RELATIVE_ZOOM = .32;
export const MAX_RELATIVE_ZOOM = 8;

/** Reserve a usable rectangle between the floating source/legend controls.
 * A narrow inspector is intentionally dismissible rather than reducing the map
 * to a few pixels. Desktop inspectors reserve their full measured width. */
export function navigationInsets(width: number, inspectorWidth = 0): ViewportInsets {
  return { top: width <= 760 ? 250 : 125, right: width > 900 && inspectorWidth ? inspectorWidth + 40 : 24, bottom: width <= 900 ? 140 : 110, left: 24 };
}

export function fitVisibleCamera(bounds: Bounds, width: number, height: number, insets: ViewportInsets, padding = 12): Camera {
  const availableWidth = Math.max(64, width - insets.left - insets.right);
  const availableHeight = Math.max(64, height - insets.top - insets.bottom);
  const zoom = Math.max(.025, Math.min(Math.max(1, availableWidth - padding * 2) / Math.max(1, bounds.width), Math.max(1, availableHeight - padding * 2) / Math.max(1, bounds.height)));
  const center = { x: insets.left + availableWidth / 2, y: insets.top + availableHeight / 2 };
  return { x: bounds.x + bounds.width / 2 - (center.x - width / 2) / zoom, y: bounds.y + bounds.height / 2 - (center.y - height / 2) / zoom, zoom };
}

export function isValidCamera(value: Camera | undefined): value is Camera {
  return !!value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.zoom) && value.zoom > 0;
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
