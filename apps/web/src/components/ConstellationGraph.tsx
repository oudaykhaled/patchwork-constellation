import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ISLAND_ALPHA, ISLAND_GEOMETRY, islandBounds, layoutPitch, MAP_BACKGROUND, neighborsOf, screenToWorld, selectedMembership, worldToScreen, zoomAt } from '../../../../packages/graph-core/src/index';
import type { Bounds, Camera, GraphData, GraphLayout, Island, Point, PositionedFile } from '../../../../packages/graph-core/src/index';
import { boundsIntersect, connectionInViewport, exceedsGraphEnvelope, scopeSummary, viewportBounds } from '../../../../packages/graph-core/src/render-policy';
import { sceneTile, sceneTranslation, type SceneTile } from '../../../../packages/graph-core/src/scene-cache';
import { useSettledLayout } from './useSettledLayout';
import { islandTipMeta } from './island-tip';
import { fitVisibleCamera, isRestorableCamera, landingWindow, MAX_RELATIVE_ZOOM, MIN_RELATIVE_ZOOM, minimapFrame, minimapPoint, navigationInsets, pinchCamera, sameCamera, type ViewportInsets } from './camera-navigation';
import './constellation-graph.css';

/** "hover": names only in the tooltip, breadcrumb, search and Files. "always": also drawn inside rectangles that fit them. */
export type IslandNames = 'hover' | 'always';

export interface ConstellationGraphProps {
  snapshot: GraphData & { id?: string; repository?: { fullName: string }; mode?: string };
  selectedSourceIds: string[];
  selectedFileId: string | null;
  onSelectFile: (id: string | null) => void;
  focusGroupId?: string | null;
  onFocusGroup?: (id: string | null) => void;
  searchQuery?: string;
  showImports?: boolean;
  onOpenFiles?: () => void;
  initialCamera?: Camera;
  onCameraChange?: (camera: Camera) => void;
  overviewRequest?: number;
  className?: string;
  layoutSeed?: number;
  layoutPins?: Record<string, Point>;
  onLayoutReady?: (layout: GraphLayout) => void;
  islandNames?: IslandNames;
  sourceKind?: 'pr' | 'commit';
  /** The map key, rendered as the left cluster of the bottom bar. It receives the "files in view" detail output
   * and, for repositories above the graph envelope, the current Explore scope sentence for its explanation. */
  legend?: (detail: ReactNode, scopeNote?: string) => ReactNode;
}

type Size = { width: number; height: number };
type IslandStats = { changed: number; overlap: number };
type IslandTip = { id: string; point: Point; via: 'pointer' | 'keyboard' };
const EMPTY_SIZE: Size = { width: 1600, height: 936 };
const DEFAULT_CAMERA: Camera = { x: 800, y: 468, zoom: 1 };
const NO_STATS: IslandStats = { changed: 0, overlap: 0 };
/** Drawing size of the minimap SVG (constellation-graph.css: 138 × 94 box, 8 px padding, 1 px border). */
const MINIMAP_PIXELS = { width: 120, height: 76 };
/** Below this on-screen lattice pitch, single files are too dense to aim at: the island under the pointer is the target. */
const FILE_TARGET_MIN_PITCH = 10;
const ISLAND_TIP_DELAY_MS = 120, ISLAND_TIP_WARM_MS = 300, HOVER_BRIDGE_MS = 220;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const basename = (path: string) => path.split('/').pop() ?? path;
const alpha = (color: string, opacity: string) => /^#[0-9a-f]{6}$/i.test(color) ? color + opacity : '#6a9ec7' + opacity;
const islandRect = (island: Island): Bounds => ({ x: island.x - island.rx, y: island.y - island.ry, width: island.rx * 2, height: island.ry * 2 });
/** Corner radius in screen px: 14% of the short side, between 2 and 10. */
const cornerRadius = (rect: Bounds, zoom: number) => clamp(.14 * Math.min(rect.width, rect.height) * zoom, 2, 10);
const contains = (outer: Bounds, inner: Bounds) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** A rounded rectangle path. Never `arc`: file circles are the only arcs on this canvas. */
function roundedRect(context: CanvasRenderingContext2D, rect: Bounds, radius: number) {
  const { x, y, width, height } = rect, r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  if (typeof context.roundRect === 'function') { context.roundRect(x, y, width, height, r); return; }
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r); context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r); context.arcTo(x, y, x + width, y, r); context.closePath();
}
function ellipsize(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (context.measureText(text).width <= maxWidth) return text;
  let low = 0, high = text.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (context.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid; else high = mid - 1; }
  return low ? `${text.slice(0, low)}…` : '';
}

export function ConstellationGraph({ snapshot, selectedSourceIds, selectedFileId, onSelectFile, focusGroupId, onFocusGroup, searchQuery = '', showImports = true, onOpenFiles, initialCamera, onCameraChange, overviewRequest = 0, className = '', layoutSeed = 0, layoutPins, onLayoutReady, islandNames = 'hover', sourceKind, legend }: ConstellationGraphProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const islandControlsRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<Camera>(DEFAULT_CAMERA);
  const sizeRef = useRef(EMPTY_SIZE);
  const animationRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const sceneCacheRef = useRef<{ tile: SceneTile; canvas: HTMLCanvasElement } | null>(null);
  const sceneMetrics = useRef({ builds: 0, hits: 0 });
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Point; last: Point; moved: boolean; pinchDistance: number | null; pinchMidpoint: Point | null }>({ start: { x: 0, y: 0 }, last: { x: 0, y: 0 }, moved: false, pinchDistance: null, pinchMidpoint: null });
  const cameraChangeRef = useRef(onCameraChange);
  cameraChangeRef.current = onCameraChange;
  const initialCameraRef = useRef(initialCamera);
  initialCameraRef.current = initialCamera;
  const lastOverviewRequest = useRef(overviewRequest);
  const [size, setSize] = useState(EMPTY_SIZE);
  const [camera, setCameraState] = useState(DEFAULT_CAMERA);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoverPosition, setHoverPosition] = useState<Point>({ x: 0, y: 0 });
  const hoveredIdRef = useRef(hoveredId);
  hoveredIdRef.current = hoveredId;
  const hoverTriggerId = useRef<string | null>(null);
  const tooltipHovered = useRef(false);
  const dismissedHoverId = useRef<string | null>(null);
  const hoverLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Island hover never enters the scene key: the ring and tooltip are DOM.
  const [hoveredIslandId, setHoveredIslandId] = useState<string | null>(null);
  const hoveredIslandRef = useRef<string | null>(null);
  const [islandTip, setIslandTipState] = useState<IslandTip | null>(null);
  const islandTipRef = useRef<IslandTip | null>(null);
  const islandTipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const islandLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const islandTipClosedAt = useRef(-Infinity);
  const dismissedIslandId = useRef<string | null>(null);
  const [keyboardIslandId, setKeyboardIslandId] = useState<string | null>(null);
  const [rovingId, setRovingId] = useState<string | null>(null);
  const [minimapOpen, setMinimapOpen] = useState(false);
  // The bottom bar is rendered into the workspace (the host's parent) so its stacking order
  // competes with the other workspace chrome; the host is an isolated stacking context.
  const [barHost, setBarHost] = useState<HTMLElement | null>(null);
  const setIslandTip = useCallback((tip: IslandTip | null) => {
    if (!tip && islandTipRef.current) islandTipClosedAt.current = performance.now();
    islandTipRef.current = tip; setIslandTipState(tip);
  }, []);
  const cancelHoverLeave = useCallback(() => {
    if (hoverLeaveTimer.current !== null) clearTimeout(hoverLeaveTimer.current);
    hoverLeaveTimer.current = null;
  }, []);
  const cancelIslandTimers = useCallback(() => {
    if (islandTipTimer.current !== null) clearTimeout(islandTipTimer.current);
    if (islandLeaveTimer.current !== null) clearTimeout(islandLeaveTimer.current);
    islandTipTimer.current = null; islandLeaveTimer.current = null;
  }, []);
  /** Ends pointer hover on islands now (ring and pointer tooltip). A keyboard tooltip stays. */
  const endIslandHover = useCallback(() => {
    cancelIslandTimers();
    hoveredIslandRef.current = null; setHoveredIslandId(null); dismissedIslandId.current = null;
    if (islandTipRef.current?.via === 'pointer') setIslandTip(null);
  }, [cancelIslandTimers, setIslandTip]);
  const clearTooltip = useCallback(() => { cancelHoverLeave(); setHoveredId(null); }, [cancelHoverLeave]);
  const leaveHover = useCallback(() => {
    if (hoverLeaveTimer.current !== null || tooltipHovered.current) return;
    // A short bridge lets the pointer cross the gap between its circle and the
    // tooltip. Content stays visible indefinitely while either is hovered.
    hoverLeaveTimer.current = setTimeout(() => {
      hoverLeaveTimer.current = null;
      if (!hoverTriggerId.current && !tooltipHovered.current) setHoveredId(null);
    }, HOVER_BRIDGE_MS);
  }, []);
  const leaveIsland = useCallback(() => {
    if (islandTipTimer.current !== null) { clearTimeout(islandTipTimer.current); islandTipTimer.current = null; }
    if (islandLeaveTimer.current !== null || tooltipHovered.current || !hoveredIslandRef.current) return;
    // The same bridge as files: crossing a gutter to the next island never flickers.
    islandLeaveTimer.current = setTimeout(() => {
      islandLeaveTimer.current = null;
      if (!tooltipHovered.current) endIslandHover();
    }, HOVER_BRIDGE_MS);
  }, [endIslandHover]);
  const [dragging, setDragging] = useState(false);
  const [canvasFailed, setCanvasFailed] = useState(false);
  const [canvasAttempt, setCanvasAttempt] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [scopeGroupId, setScopeGroupId] = useState<string | null>(null);
  const { layout, layoutState, layoutError, resetLayout } = useSettledLayout(snapshot, layoutSeed, layoutPins);
  useEffect(() => { if (layoutState === 'ready') onLayoutReady?.(layout); }, [layout, layoutState, onLayoutReady]);
  const framedRepository = useRef<string | null>(null);
  const landedCamera = useRef<{ camera: Camera } | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(0);
  const membership = useMemo(() => selectedMembership(snapshot, selectedSourceIds), [snapshot, selectedSourceIds]);
  const neighbors = useMemo(() => neighborsOf(snapshot.edges, selectedFileId), [snapshot.edges, selectedFileId]);
  // Per-island counts once per membership change, not per render or per frame.
  const islandStats = useMemo(() => {
    const stats = new Map<string, IslandStats>();
    for (const island of layout.islands) {
      let changed = 0, overlap = 0;
      for (const node of island.nodes) { const count = membership.get(node.id) ?? 0; if (count) changed++; if (count > 1) overlap++; }
      stats.set(island.id, { changed, overlap });
    }
    return stats;
  }, [layout.islands, membership]);
  const largeRepository = exceedsGraphEnvelope(snapshot);
  const compact = size.width <= 760;
  const search = searchQuery.trim().toLowerCase();
  const selectedPosition = selectedFileId ? layout.nodeById.get(selectedFileId) : undefined;
  const focusedIsland = focusGroupId ? layout.islands.find(island => island.id === focusGroupId) : undefined;
  const hovered = hoveredId ? layout.nodeById.get(hoveredId) : undefined;
  const islandById = useMemo(() => new Map(layout.islands.map(island => [island.id, island])), [layout.islands]);
  useEffect(() => {
    clearTooltip(); hoverTriggerId.current = null; tooltipHovered.current = false; dismissedHoverId.current = null;
    cancelIslandTimers(); hoveredIslandRef.current = null; setHoveredIslandId(null); setIslandTip(null); dismissedIslandId.current = null;
  }, [layout, scopeGroupId, clearTooltip, cancelIslandTimers, setIslandTip]);
  useEffect(() => {
    const dismiss = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || (!hoveredIdRef.current && !islandTipRef.current)) return;
      const fileHover = !!hoveredIdRef.current, pointerIslandTip = islandTipRef.current?.via === 'pointer';
      // Hover can coexist with focus in another control. Dismiss it without
      // moving that focus, changing source selection or closing file details.
      if (hoveredIdRef.current) { dismissedHoverId.current = hoveredIdRef.current; tooltipHovered.current = false; clearTooltip(); }
      if (islandTipRef.current) { dismissedIslandId.current = islandTipRef.current.id; tooltipHovered.current = false; setIslandTip(null); }
      // A native modal makes the underlying graph inert. Its own Escape
      // handling takes priority over hover content behind the backdrop.
      if (document.querySelector('dialog[open]')) return;
      // An island tooltip is open whenever the mouse rests on the map. Closing it must not use
      // up the Escape that search, a menu or the ? explanation is waiting for: unless the map
      // itself has focus, that control still receives this key.
      const focused = document.activeElement;
      if (!fileHover && pointerIslandTip && focused && focused !== document.body && !hostRef.current?.contains(focused)) return;
      event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener('keydown', dismiss, true);
    return () => { window.removeEventListener('keydown', dismiss, true); cancelHoverLeave(); cancelIslandTimers(); };
  }, [clearTooltip, cancelHoverLeave, cancelIslandTimers, setIslandTip]);
  const scope = useMemo(() => scopeSummary(snapshot, scopeGroupId), [snapshot.nodes, snapshot.edges, scopeGroupId]);
  /** Fixed chrome insets, raised to the measured top strip and bottom bar when they wrap. */
  const measureInsets = useCallback((width: number): ViewportInsets => {
    const host = hostRef.current;
    const inspector = host?.parentElement?.querySelector('[data-testid="file-inspector"]');
    const base = navigationInsets(width, inspector?.getBoundingClientRect().width ?? 0);
    if (!host) return base;
    const hostBox = host.getBoundingClientRect();
    const strip = host.parentElement?.querySelector('.graph-strip')?.getBoundingClientRect();
    const bar = barRef.current?.getBoundingClientRect();
    return {
      ...base,
      top: strip?.height ? Math.max(base.top, Math.round(strip.bottom - hostBox.top + 12)) : base.top,
      bottom: bar?.height ? Math.max(base.bottom, Math.round(hostBox.bottom - bar.top + 12)) : base.bottom,
    };
  }, []);
  const [insets, setInsets] = useState<ViewportInsets>(() => navigationInsets(EMPTY_SIZE.width));
  const fit = useMemo(() => fitVisibleCamera(layout.bounds, size.width, size.height, insets), [layout.bounds, size, insets]);
  const fitBounds = useCallback((bounds: Bounds) => fitVisibleCamera(bounds, sizeRef.current.width, sizeRef.current.height, measureInsets(sizeRef.current.width)), [measureInsets]);
  const latest = useRef({ layout, snapshot, membership, neighbors, selectedFileId, hoveredId, search, showImports, scopeGroupId, islandStats, islandNames });
  latest.current = { layout, snapshot, membership, neighbors, selectedFileId, hoveredId, search, showImports, scopeGroupId, islandStats, islandNames };

  const draw = useCallback(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    const screenContext = canvas?.getContext('2d');
    if (!canvas || !screenContext) return;
    let { width, height } = sizeRef.current;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const c = cameraRef.current;
    const data = latest.current;
    screenContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    screenContext.clearRect(0, 0, width, height);
    screenContext.fillStyle = MAP_BACKGROUND; screenContext.fillRect(0, 0, width, height);
    // Screen-space grid deliberately remains subtle throughout zooming.
    const grid = clamp(32 * c.zoom, 19, 42);
    const offsetX = ((width / 2 - c.x * c.zoom) % grid + grid) % grid;
    const offsetY = ((height / 2 - c.y * c.zoom) % grid + grid) % grid;
    screenContext.fillStyle = '#16272a';
    for (let x = offsetX; x < width; x += grid) for (let y = offsetY; y < height; y += grid) screenContext.fillRect(x, y, 1.2, 1.2);
    // Rasterizing thousands of identical curves on every translation costs more
    // than camera updates, especially on software-rendered CI browsers. Keep one
    // padded bitmap of the complete current scene; pan copies those exact pixels.
    // Any data/highlight/scope/zoom/DPR/resize change rebuilds it. No facts or
    // edges are removed for this optimization, and allocation has a fixed cap.
    // Island hover/focus rings are DOM and deliberately absent from this key.
    const sceneKey = [data.layout, data.snapshot.edges, data.membership, data.neighbors, data.selectedFileId, data.hoveredId, data.search, data.showImports, data.scopeGroupId, data.islandStats, data.islandNames];
    const previousScene = sceneCacheRef.current;
    const translation = sceneTranslation(previousScene?.tile ?? null, c, width, height, ratio, sceneKey);
    if (previousScene && translation) {
      screenContext.drawImage(previousScene.canvas, translation.x, translation.y, previousScene.canvas.width / ratio, previousScene.canvas.height / ratio);
      canvas.dataset.sceneCacheHits = String(++sceneMetrics.current.hits);
      return;
    }
    const tile = sceneTile(c, width, height, ratio, sceneKey);
    const bitmap = tile ? previousScene?.canvas ?? document.createElement('canvas') : null;
    let context = screenContext;
    if (tile && bitmap) {
      const bitmapWidth = Math.ceil((width + tile.padding * 2) * ratio), bitmapHeight = Math.ceil((height + tile.padding * 2) * ratio);
      if (bitmap.width !== bitmapWidth) bitmap.width = bitmapWidth;
      if (bitmap.height !== bitmapHeight) bitmap.height = bitmapHeight;
      const bitmapContext = bitmap.getContext('2d');
      if (bitmapContext) {
        context = bitmapContext; width += tile.padding * 2; height += tile.padding * 2;
        context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
      }
    }
    const caching = context !== screenContext && tile && bitmap;
    if (!caching && previousScene) { previousScene.canvas.width = 0; previousScene.canvas.height = 0; sceneCacheRef.current = null; }
    context.translate(width / 2, height / 2); context.scale(c.zoom, c.zoom); context.translate(-c.x, -c.y);
    const viewport = viewportBounds(c, width, height, 30);
    const px = 1 / c.zoom;
    const inScope = (node: PositionedFile) => !data.scopeGroupId || node.groupId === data.scopeGroupId;
    const visible = (node: Point, extra = 25) => Math.abs((node.x - c.x) * c.zoom) < width / 2 + extra && Math.abs((node.y - c.y) * c.zoom) < height / 2 + extra;
    const selectedIslandId = data.selectedFileId ? data.layout.islands.find(island => island.nodes.some(node => node.id === data.selectedFileId))?.id : undefined;
    // Quiet by default: unchanged islands are a 1 px outline in their own colour;
    // islands the selection touched get the green border and a count badge.
    const drawn: { island: Island; rect: Bounds; changed: number }[] = [];
    for (const island of data.layout.islands) {
      if (data.scopeGroupId && island.id !== data.scopeGroupId) continue;
      const rect = islandRect(island);
      if (!boundsIntersect(viewport, rect)) continue;
      const changed = data.islandStats.get(island.id)?.changed ?? 0;
      const dimmed = !!selectedIslandId && island.id !== selectedIslandId;
      roundedRect(context, rect, cornerRadius(rect, c.zoom) * px);
      context.fillStyle = alpha(island.color, dimmed ? ISLAND_ALPHA.dimmedFill : changed ? ISLAND_ALPHA.changedFill : ISLAND_ALPHA.fill); context.fill();
      context.globalAlpha = dimmed ? .6 : 1;
      // An undimmed unchanged border keeps at least 3:1 against the map and its own fill for every
      // palette colour (ISLAND_ALPHA.border; asserted in graph-core tests).
      context.strokeStyle = changed ? '#42b968f2' : alpha(island.color, ISLAND_ALPHA.border); context.lineWidth = (changed ? 1.5 : 1) * px; context.stroke();
      context.globalAlpha = 1;
      drawn.push({ island, rect, changed });
    }
    const focusedEdges: typeof data.snapshot.edges = [];
    const connectionFocus = data.selectedFileId ?? data.hoveredId;
    context.lineWidth = .68 / c.zoom; context.strokeStyle = '#3c575c66'; context.beginPath();
    const suppressEdges = data.snapshot.edges.length > 10000 && c.zoom < .6;
    data.snapshot.edges.forEach((edge, i) => {
      if (!data.showImports) return;
      const from = data.layout.nodeById.get(edge.source); const to = data.layout.nodeById.get(edge.target);
      if (!from || !to || !inScope(from) || !inScope(to)) return;
      if (connectionFocus && (from.id === connectionFocus || to.id === connectionFocus)) { focusedEdges.push(edge); return; }
      if ((suppressEdges && i % 3 !== 0) || !connectionInViewport(from, to, viewport)) return;
      context.moveTo(from.x, from.y);
      const curve = (hashEdge(edge.id) % 2 ? 1 : -1) * Math.min(25, Math.abs(from.x - to.x) * .12);
      context.quadraticCurveTo((from.x + to.x) / 2 + curve, (from.y + to.y) / 2 - curve, to.x, to.y);
    });
    context.globalAlpha = connectionFocus ? .24 : 1; context.stroke(); context.globalAlpha = 1;
    if (focusedEdges.length) {
      context.strokeStyle = '#8ae4b7bb'; context.lineWidth = 1.15 / c.zoom;
      for (const edge of focusedEdges) {
        const from = data.layout.nodeById.get(edge.source)!; const to = data.layout.nodeById.get(edge.target)!;
        context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
        const angle = Math.atan2(to.y - from.y, to.x - from.x), arrow = 4 / c.zoom;
        const endX = to.x - Math.cos(angle) * 9 / c.zoom, endY = to.y - Math.sin(angle) * 9 / c.zoom;
        context.beginPath(); context.moveTo(endX, endY); context.lineTo(endX - Math.cos(angle - .55) * arrow, endY - Math.sin(angle - .55) * arrow);
        context.moveTo(endX, endY); context.lineTo(endX - Math.cos(angle + .55) * arrow, endY - Math.sin(angle + .55) * arrow); context.stroke();
      }
    }
    const labels: { node: PositionedFile; priority: number; home?: Bounds }[] = [];
    // "Multiple selected sources" rings are a fixed screen size. On a dense overview they would merge
    // into blobs: below an 8 px file pitch they are left out (the island tooltip and the overlap count
    // carry the number), and below 10 px they are capped at 0.45 pitch with a 1 px stroke.
    const pitchOnScreen = layoutPitch(data.layout) * c.zoom;
    for (const node of data.layout.nodes) {
      if (!inScope(node) || !visible(node)) continue;
      const count = data.membership.get(node.id) ?? 0;
      const isSelected = node.id === data.selectedFileId;
      const isNeighbor = data.neighbors.has(node.id);
      const isSearch = !!data.search && node.path.toLowerCase().includes(data.search);
      const dim = (!!data.selectedFileId && !isSelected && !isNeighbor) || (!!data.search && !isSearch);
      const radius = clamp(6.6 * c.zoom, 2.2, 11) / c.zoom;
      context.globalAlpha = dim ? .22 : 1;
      if (isSelected || isSearch) { context.shadowColor = '#a2f4ba'; context.shadowBlur = isSelected ? 16 : 9; }
      context.beginPath(); context.arc(node.x, node.y, radius, 0, Math.PI * 2);
      context.fillStyle = isSelected ? '#a2f4ba' : count ? '#42b968' : '#18252a'; context.fill();
      context.shadowBlur = 0;
      context.strokeStyle = count || isSelected ? '#a0e3b0' : '#52686d'; context.lineWidth = .65 / c.zoom; context.stroke();
      const overlapOnly = count > 1 && !isSelected && !isNeighbor && node.id !== data.hoveredId && !isSearch;
      if ((count > 1 || isSelected || isNeighbor || node.id === data.hoveredId || isSearch) && !(overlapOnly && pitchOnScreen < 8)) {
        const capped = overlapOnly && pitchOnScreen < 10;
        context.beginPath(); context.arc(node.x, node.y, capped ? Math.min(radius + 3.6 / c.zoom, .45 * pitchOnScreen / c.zoom) : radius + 3.6 / c.zoom, 0, Math.PI * 2);
        context.strokeStyle = isSelected ? '#e1ffec' : count > 1 ? '#d7e8de' : '#8bc7a5'; context.lineWidth = (isSelected ? 1.6 : 1) / c.zoom; context.stroke();
      }
      // Four corner brackets identify selection independently of the overlap ring
      // and remain distinct under monochrome/high-contrast viewing.
      if (isSelected) {
        const extent = radius + 7 / c.zoom, arm = 4 / c.zoom;
        context.strokeStyle = '#ffffff'; context.lineWidth = 1.6 / c.zoom;
        context.beginPath();
        for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
          const x = node.x + dx * extent, y = node.y + dy * extent;
          context.moveTo(x - dx * arm, y); context.lineTo(x, y); context.lineTo(x, y - dy * arm);
        }
        context.stroke();
      }
      context.globalAlpha = 1;
      if (isSelected || isSearch || node.id === data.hoveredId || (isNeighbor && c.zoom > .7) || (c.zoom > 1.25 && count)) labels.push({ node, priority: isSelected ? 0 : isSearch ? 1 : isNeighbor ? 2 : 3 });
    }
    // Count badges sit inside the top-right corner of changed islands that are large
    // enough on screen; smaller changed islands rely on the green border alone.
    const boxes: Bounds[] = [];
    const badgeWidths = new Map<string, number>();
    context.font = `600 ${10 * px}px 'Geist Mono', 'SFMono-Regular', Consolas, monospace`;
    context.textAlign = 'center'; context.textBaseline = 'middle';
    for (const { island, rect, changed } of drawn) {
      if (!changed || rect.width * c.zoom < 36 || rect.height * c.zoom < 24) continue;
      const text = String(changed), badgeWidth = Math.max(14 * px, context.measureText(text).width + 8 * px);
      const badge = { x: rect.x + rect.width - 3 * px - badgeWidth, y: rect.y + 3 * px, width: badgeWidth, height: 14 * px };
      roundedRect(context, badge, 7 * px); context.fillStyle = '#42b968'; context.fill();
      context.fillStyle = '#06130a'; context.fillText(text, badge.x + badge.width / 2, badge.y + badge.height / 2 + .5 * px);
      boxes.push(badge); badgeWidths.set(island.id, badgeWidth);
    }
    context.textAlign = 'start'; context.textBaseline = 'alphabetic';
    // "Always" names: inside their own rectangle only, never over a neighbour.
    const nameBands = new Map<string, Bounds>();
    if (data.islandNames === 'always') {
      context.font = `500 ${11 * px}px Geist, Inter, -apple-system, 'Segoe UI', sans-serif`;
      for (const { island, rect } of drawn) {
        if (rect.width * c.zoom < 72 || rect.height * c.zoom < 40) continue;
        const room = rect.width - 8 * px - (badgeWidths.has(island.id) ? badgeWidths.get(island.id)! + 4 * px : 0);
        const text = ellipsize(context, island.label, room - 12 * px);
        if (!text) continue;
        const band = { x: rect.x + 4 * px, y: rect.y + 4 * px, width: Math.min(room, context.measureText(text).width + 12 * px), height: 18 * px };
        context.fillStyle = '#0a1217d9'; roundedRect(context, band, 4 * px); context.fill();
        context.fillStyle = '#dcebe4'; context.fillText(text, band.x + 6 * px, band.y + 13 * px);
        boxes.push(band); nameBands.set(island.id, band);
      }
    }
    // A representative file label per island only once file pitch reaches 18 px on
    // screen, and only inside its own rectangle, so the overview stays quiet.
    if (c.zoom * layoutPitch(data.layout) >= 18 && c.zoom <= 1.25 && !data.selectedFileId && !data.search) for (const { island, rect } of drawn) {
      const representative = island.nodes.find(node => data.membership.has(node.id)) ?? island.nodes[0];
      if (representative) labels.push({ node: representative, priority: 4, home: rect });
    }
    context.font = `${10 / c.zoom}px 'Geist Mono', 'SFMono-Regular', Consolas, monospace`;
    labels.sort((a, b) => a.priority - b.priority).slice(0, 100).forEach(({ node, priority, home }) => {
      const label = basename(node.path); const textWidth = context.measureText(label).width;
      const box = { x: node.x + 15 / c.zoom, y: node.y - 12 / c.zoom, width: textWidth + 15 / c.zoom, height: 24 / c.zoom };
      if (!visible(node, -10) || (priority > 0 && boxes.some(b => intersects(b, box)))) return;
      if (home && !contains(home, box)) return;
      boxes.push(box); context.fillStyle = '#0a1217ef'; context.fillRect(box.x, box.y, box.width, box.height);
      context.fillStyle = priority < 3 ? '#dcebe4' : '#a2b1aa'; context.fillText(label, box.x + 7 / c.zoom, box.y + 15 / c.zoom);
    });
    if (caching) {
      sceneCacheRef.current = { tile, canvas: bitmap };
      screenContext.drawImage(bitmap, -tile.padding, -tile.padding, bitmap.width / ratio, bitmap.height / ratio);
      canvas.dataset.sceneCacheBytes = String(bitmap.width * bitmap.height * 4);
    } else {
      // The main context was transformed for direct rendering. Reset it so the
      // next frame always starts in screen coordinates, including fallback.
      screenContext.setTransform(ratio, 0, 0, ratio, 0, 0);
      canvas.dataset.sceneCacheBytes = '0';
    }
    canvas.dataset.sceneCacheBuilds = String(++sceneMetrics.current.builds);
    canvas.dataset.sceneCacheHits = String(sceneMetrics.current.hits);
  }, []);

  const requestDraw = useCallback(() => { if (frameRef.current === null) frameRef.current = requestAnimationFrame(draw); }, [draw]);
  const setCamera = useCallback((next: Camera) => {
    cameraRef.current = next; setCameraState(next);
    const repository = latest.current.snapshot.repository?.fullName ?? latest.current.snapshot.id ?? 'graph';
    // Resize can run before the layout worker returns. Its empty-layout fit is
    // internal bootstrap state and must never become a restorable shared camera.
    if (framedRepository.current === repository) cameraChangeRef.current?.(next);
    requestDraw();
  }, [requestDraw]);
  const stopAnimation = useCallback(() => { if (animationRef.current !== null) cancelAnimationFrame(animationRef.current); animationRef.current = null; }, []);
  const moveCamera = useCallback((next: Camera, animate = true) => {
    stopAnimation();
    if (reducedMotion || !animate) { setCamera(next); return; }
    const before = cameraRef.current; const start = performance.now();
    const tick = (time: number) => {
      const progress = clamp((time - start) / 320, 0, 1); const eased = 1 - (1 - progress) ** 3;
      setCamera({ x: before.x + (next.x - before.x) * eased, y: before.y + (next.y - before.y) * eased, zoom: before.zoom + (next.zoom - before.zoom) * eased });
      animationRef.current = progress < 1 ? requestAnimationFrame(tick) : null;
    };
    animationRef.current = requestAnimationFrame(tick);
  }, [reducedMotion, setCamera, stopAnimation]);
  /** Desktop lands on Fit all. A phone above the envelope lands on the changed islands at a readable zoom. */
  const landingCamera = useCallback((): { camera: Camera } => {
    const { layout: current, snapshot: data, islandStats: stats } = latest.current;
    const fitted = fitBounds(current.bounds);
    const { width, height } = sizeRef.current;
    if (width > 760 || !exceedsGraphEnvelope(data)) return { camera: fitted };
    const changed = current.islands.flatMap(island => { const count = stats.get(island.id)?.changed ?? 0; return count ? [{ ...islandRect(island), weight: count }] : []; });
    const zoom = Math.max(fitted.zoom, .2), inset = measureInsets(width);
    // The visible map (between the chrome insets) that holds the most changed files in whole islands
    // and leaves the fewest changed islands cut or behind the chrome; the camera centres on it.
    const chrome = { top: inset.top / zoom, right: inset.right / zoom, bottom: inset.bottom / zoom, left: inset.left / zoom };
    const box = landingWindow(changed, Math.max(1, width - inset.left - inset.right) / zoom, Math.max(1, height - inset.top - inset.bottom) / zoom, chrome) ?? current.bounds;
    const anchor = { x: (inset.left + width - inset.right) / 2, y: (inset.top + height - inset.bottom) / 2 };
    return { camera: { x: box.x + box.width / 2 - (anchor.x - width / 2) / zoom, y: box.y + box.height / 2 - (anchor.y - height / 2) / zoom, zoom } };
  }, [fitBounds, measureInsets]);
  const fitAll = useCallback(() => { setScopeGroupId(null); onFocusGroup?.(null); moveCamera(fitBounds(layout.bounds)); }, [layout.bounds, moveCamera, onFocusGroup, fitBounds]);
  const fitIsland = useCallback((id: string) => {
    const island = layout.islands.find(group => group.id === id);
    if (island) { onFocusGroup?.(id); moveCamera(fitBounds(islandBounds(island))); }
  }, [layout.islands, onFocusGroup, moveCamera, fitBounds]);
  /** Keyboard focus pans (never zooms) the minimum distance that shows the whole rectangle. */
  const ensureIslandVisible = useCallback((id: string) => {
    const island = layout.islands.find(group => group.id === id); if (!island) return;
    const { width, height } = sizeRef.current, c = cameraRef.current, inset = measureInsets(width);
    const topLeft = worldToScreen({ x: island.x - island.rx, y: island.y - island.ry }, c, width, height);
    const bottomRight = worldToScreen({ x: island.x + island.rx, y: island.y + island.ry }, c, width, height);
    const shift = (low: number, high: number, min: number, max: number) => low < min || high - low > max - min ? low - min : high > max ? high - max : 0;
    const dx = shift(topLeft.x, bottomRight.x, inset.left, width - inset.right), dy = shift(topLeft.y, bottomRight.y, inset.top, height - inset.bottom);
    if (dx || dy) moveCamera({ ...c, x: c.x + dx / c.zoom, y: c.y + dy / c.zoom });
  }, [layout.islands, measureInsets, moveCamera]);
  const zoom = useCallback((factor: number, anchor?: Point) => {
    stopAnimation(); const { width, height } = sizeRef.current; const c = cameraRef.current;
    setCamera(zoomAt(c, clamp(c.zoom * factor, fit.zoom * MIN_RELATIVE_ZOOM, Math.max(4.8, fit.zoom * MAX_RELATIVE_ZOOM)), anchor ?? { x: width / 2, y: height / 2 }, width, height));
  }, [fit.zoom, setCamera, stopAnimation]);
  const pan = useCallback((x: number, y: number) => {
    stopAnimation(); const c = cameraRef.current;
    setCamera({ ...c, x: c.x + x / c.zoom, y: c.y + y / c.zoom });
  }, [setCamera, stopAnimation]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)'); const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const inspector = hostRef.current?.parentElement?.querySelector('[data-testid="file-inspector"]');
    if (!inspector) { setInspectorWidth(0); return; }
    const update = () => setInspectorWidth(inspector.getBoundingClientRect().width);
    update(); const observer = new ResizeObserver(update); observer.observe(inspector);
    return () => observer.disconnect();
  }, [selectedFileId]);
  useEffect(() => {
    const workspace = hostRef.current?.parentElement ?? null; setBarHost(workspace);
    // Keyboard focus may land on an island button outside the visible map. The camera pans
    // to it (ensureIslandVisible); the page itself must never scroll.
    const shell = workspace?.parentElement ?? null;
    const reset = (event: Event) => { const element = event.currentTarget as HTMLElement; if (element.scrollTop || element.scrollLeft) { element.scrollTop = 0; element.scrollLeft = 0; } };
    for (const element of [hostRef.current, workspace, shell]) element?.addEventListener('scroll', reset);
    return () => { for (const element of [hostRef.current, workspace, shell]) element?.removeEventListener('scroll', reset); };
  }, []);
  // The fit readout follows the chrome: inspector, a wrapped top strip or a wrapped bottom bar.
  useEffect(() => {
    const update = () => setInsets(previous => {
      const next = measureInsets(sizeRef.current.width);
      return previous.top === next.top && previous.right === next.right && previous.bottom === next.bottom && previous.left === next.left ? previous : next;
    });
    update();
    const observer = new ResizeObserver(update);
    const strip = hostRef.current?.parentElement?.querySelector('.graph-strip');
    if (strip) observer.observe(strip);
    if (barRef.current) observer.observe(barRef.current);
    return () => observer.disconnect();
  }, [measureInsets, size.width, inspectorWidth, largeRepository, snapshot, barHost]);
  useEffect(() => {
    const host = hostRef.current; const canvas = canvasRef.current;
    if (!host || !canvas) return;
    if (!canvas.getContext('2d')) { setCanvasFailed(true); return; }
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect; if (!rect.width || !rect.height) return;
      const nextSize = { width: rect.width, height: rect.height }; const first = sizeRef.current === EMPTY_SIZE;
      sizeRef.current = nextSize; setSize(nextSize);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
      if (first) {
        const current = latest.current.layout, restored = initialCameraRef.current;
        setCamera(isRestorableCamera(restored, fitBounds(current.bounds), current.islands.map(islandRect), nextSize.width, nextSize.height, measureInsets(nextSize.width)) ? restored : fitBounds(current.bounds));
      } else requestDraw();
    });
    observer.observe(host); return () => observer.disconnect();
  }, [requestDraw, setCamera, fitBounds, measureInsets, canvasAttempt]);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const discard = () => { const cache = sceneCacheRef.current; if (cache) { cache.canvas.width = 0; cache.canvas.height = 0; sceneCacheRef.current = null; } };
    const lost = (event: Event) => { event.preventDefault(); discard(); setCanvasFailed(true); };
    const restored = () => { discard(); setCanvasFailed(false); setCanvasAttempt(value => value + 1); requestDraw(); };
    canvas.addEventListener('contextlost', lost); canvas.addEventListener('contextrestored', restored);
    return () => { canvas.removeEventListener('contextlost', lost); canvas.removeEventListener('contextrestored', restored); };
  }, [requestDraw]);
  useEffect(() => {
    const loaded = () => { const cache = sceneCacheRef.current; if (cache) { cache.canvas.width = 0; cache.canvas.height = 0; sceneCacheRef.current = null; } requestDraw(); };
    document.fonts?.addEventListener('loadingdone', loaded);
    return () => document.fonts?.removeEventListener('loadingdone', loaded);
  }, [requestDraw]);
  // A source response can replace arrays while retaining the same context snapshot.
  // Only a new snapshot/grouping key resets framing; source toggles never do.
  useEffect(() => {
    if (layoutState !== 'ready') return;
    const repository = snapshot.repository?.fullName ?? snapshot.id ?? 'graph';
    if (framedRepository.current === repository) return;
    framedRepository.current = repository;
    // A saved camera that no longer frames this layout (for example one recorded against the
    // larger organic-island layout) is ignored; the landing camera then replaces it in the URL.
    const restored = initialCameraRef.current, { width, height } = sizeRef.current;
    if (isRestorableCamera(restored, fitBounds(layout.bounds), layout.islands.map(islandRect), width, height, measureInsets(width))) { landedCamera.current = null; moveCamera(restored, false); return; }
    const landing = landingCamera(); landedCamera.current = landing;
    moveCamera(landing.camera, false);
  }, [snapshot.id, snapshot.repository?.fullName, layoutState, moveCamera, landingCamera]);
  // A re-packed map (an overlay overflowed an island) changes the world bounds. A camera still
  // resting where it landed, or at Fit all, follows the new map; any other camera stays put.
  const settledLayout = useRef<{ repository: string; bounds: Bounds } | null>(null);
  useEffect(() => {
    if (layoutState !== 'ready') return;
    const repository = snapshot.repository?.fullName ?? snapshot.id ?? 'graph';
    const previous = settledLayout.current; settledLayout.current = { repository, bounds: layout.bounds };
    if (!previous || previous.repository !== repository || framedRepository.current !== repository) return;
    const before = previous.bounds, after = layout.bounds;
    if (before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height) return;
    const current = cameraRef.current;
    if (animationRef.current !== null) return;
    if (landedCamera.current?.camera === current) { const landing = landingCamera(); landedCamera.current = landing; moveCamera(landing.camera, false); }
    else if (sameCamera(current, fitBounds(before))) moveCamera(fitBounds(after), false);
  }, [layout, layoutState, snapshot.id, snapshot.repository?.fullName, moveCamera, landingCamera, fitBounds]);
  // A landing camera that has not moved since it landed follows what it was computed from: the
  // chrome insets (the strip is taller while 'Updating footprint' shows) and, on a phone, the
  // footprint as it settles from provisional to final highlights. It never interrupts a camera
  // animation (a file or island focus) and never moves a camera the user has moved.
  useEffect(() => {
    const landed = landedCamera.current;
    if (!landed || cameraRef.current !== landed.camera || animationRef.current !== null) return;
    const landing = landingCamera();
    if (sameCamera(landing.camera, landed.camera)) return;
    landedCamera.current = landing; moveCamera(landing.camera, false);
  }, [islandStats, insets, landingCamera, moveCamera]);
  useEffect(() => {
    if (lastOverviewRequest.current === overviewRequest) return;
    lastOverviewRequest.current = overviewRequest; fitAll();
  }, [overviewRequest, fitAll]);
  useEffect(() => { requestDraw(); }, [layout, snapshot.edges, membership, neighbors, selectedFileId, hoveredId, search, showImports, scopeGroupId, islandStats, islandNames, requestDraw]);
  useEffect(() => { if (scopeGroupId && !snapshot.groups.some(group => group.id === scopeGroupId)) setScopeGroupId(null); }, [snapshot.groups, scopeGroupId]);
  useEffect(() => { if (selectedPosition && scopeGroupId && selectedPosition.groupId !== scopeGroupId) setScopeGroupId(null); }, [selectedPosition?.id, selectedPosition?.groupId, scopeGroupId]);
  useEffect(() => { if (focusGroupId) setRovingId(focusGroupId); }, [focusGroupId]);
  useEffect(() => {
    if (!focusGroupId) return;
    const island = layout.islands.find(group => group.id === focusGroupId);
    if (island) moveCamera(fitBounds(islandBounds(island)));
  }, [focusGroupId, focusedIsland?.x, focusedIsland?.y, focusedIsland?.rx, focusedIsland?.ry, moveCamera, fitBounds]);
  useEffect(() => {
    if (!selectedFileId) return;
    const node = layout.nodeById.get(selectedFileId); if (!node) return;
    const current = cameraRef.current;
    const next = fitBounds({ x: node.x - 120, y: node.y - 100, width: 240, height: 200 });
    const zoom = Math.max(current.zoom, fit.zoom * 1.75);
    const size = sizeRef.current;
    const inset = measureInsets(size.width);
    const anchor = { x: (inset.left + size.width - inset.right) / 2, y: (inset.top + size.height - inset.bottom) / 2 };
    moveCamera({ ...next, x: node.x - (anchor.x - size.width / 2) / zoom, y: node.y - (anchor.y - size.height / 2) / zoom, zoom });
  }, [selectedFileId, selectedPosition?.x, selectedPosition?.y, moveCamera, fitBounds]);
  useEffect(() => () => {
    stopAnimation();
    const cache = sceneCacheRef.current;
    if (cache) { cache.canvas.width = 0; cache.canvas.height = 0; sceneCacheRef.current = null; }
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    // React StrictMode deliberately mounts effects twice. A cancelled frame is
    // no longer scheduled and must not prevent the remounted effect drawing.
    frameRef.current = null;
    pointers.current.clear();
  }, [stopAnimation]);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      // Modified wheel belongs to the browser. Graph touch pinch is handled by
      // Pointer Events; browser/page zoom must remain available over the canvas.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault(); const rect = canvas.getBoundingClientRect();
      zoom(Math.exp(-clamp(event.deltaY, -180, 180) * .003), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    canvas.addEventListener('wheel', wheel, { passive: false }); return () => canvas.removeEventListener('wheel', wheel);
  }, [zoom]);

  const eventPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => { const rect = event.currentTarget.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  /** Files are pointer targets once their lattice is at least 10 px apart on screen. */
  const filesTargetable = () => cameraRef.current.zoom * layoutPitch(layout) >= FILE_TARGET_MIN_PITCH;
  /**
   * A file is the pointer target within its circle plus 3 px (at most 16 px). On a tight
   * lattice that stays below the pitch, so the gaps between files and the island's padding
   * band still belong to the island and keep its tooltip and click.
   */
  const fileHitRadius = () => { const zoom = cameraRef.current.zoom; return Math.min(16, Math.max(clamp(6.6 * zoom, 2.2, 11) + 3, .35 * zoom * layoutPitch(layout))); };
  const hitNode = (point: Point) => {
    if (!filesTargetable()) return undefined;
    let found: PositionedFile | undefined; let best = fileHitRadius();
    for (const node of layout.nodes) { if (scopeGroupId && node.groupId !== scopeGroupId) continue; const screen = worldToScreen(node, cameraRef.current, sizeRef.current.width, sizeRef.current.height); const distance = Math.hypot(screen.x - point.x, screen.y - point.y); if (distance < best) { found = node; best = distance; } }
    return found;
  };
  /** Point-in-rectangle over in-scope islands, keeping the active island across a 16 px edge band. */
  const hitIsland = (point: Point) => {
    const { width, height } = sizeRef.current, c = cameraRef.current, world = screenToWorld(point, c, width, height);
    const inside = (island: Island, slack = 0) => Math.abs(world.x - island.x) <= island.rx + slack && Math.abs(world.y - island.y) <= island.ry + slack;
    for (const island of layout.islands) if ((!scopeGroupId || island.id === scopeGroupId) && inside(island)) return island;
    const active = hoveredIslandRef.current ? islandById.get(hoveredIslandRef.current) : undefined;
    return active && (!scopeGroupId || active.id === scopeGroupId) && inside(active, 16 / c.zoom) ? active : undefined;
  };
  const hoverIsland = (island: Island, point: Point) => {
    if (islandLeaveTimer.current !== null) { clearTimeout(islandLeaveTimer.current); islandLeaveTimer.current = null; }
    if (hoveredIslandRef.current !== island.id) { hoveredIslandRef.current = island.id; setHoveredIslandId(island.id); dismissedIslandId.current = null; }
    if (dismissedIslandId.current === island.id || islandTipRef.current?.id === island.id) return;
    // Warm state: while a tooltip is open, or closed a moment ago, the next island switches at once.
    const warm = !!islandTipRef.current || !!hoveredIdRef.current || performance.now() - islandTipClosedAt.current < ISLAND_TIP_WARM_MS;
    if (islandTipTimer.current !== null) clearTimeout(islandTipTimer.current);
    islandTipTimer.current = null;
    if (warm) { clearTooltip(); setIslandTip({ id: island.id, point, via: 'pointer' }); return; }
    islandTipTimer.current = setTimeout(() => {
      islandTipTimer.current = null;
      if (hoveredIslandRef.current === island.id && !pointers.current.size) setIslandTip({ id: island.id, point, via: 'pointer' });
    }, ISLAND_TIP_DELAY_MS);
  };
  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    stopAnimation(); const point = eventPoint(event); pointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus();
    const points = [...pointers.current.values()];
    gesture.current = { start: point, last: point, moved: points.length > 1, pinchDistance: points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : null, pinchMidpoint: points.length > 1 ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : null }; setDragging(true); clearTooltip(); hoverTriggerId.current = null;
    endIslandHover();
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = eventPoint(event);
    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, point);
      const points = [...pointers.current.values()];
      if (points.length >= 2) {
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        const midpoint = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        if (gesture.current.pinchDistance && gesture.current.pinchMidpoint) {
          const c = cameraRef.current, { width, height } = sizeRef.current;
          const scale = clamp(c.zoom * distance / gesture.current.pinchDistance, fit.zoom * MIN_RELATIVE_ZOOM, Math.max(4.8, fit.zoom * MAX_RELATIVE_ZOOM));
          setCamera(pinchCamera(c, gesture.current.pinchMidpoint, midpoint, scale, width, height));
        }
        gesture.current.pinchDistance = distance; gesture.current.pinchMidpoint = midpoint; gesture.current.moved = true;
      } else {
        const deltaX = point.x - gesture.current.last.x, deltaY = point.y - gesture.current.last.y;
        const c = cameraRef.current; setCamera({ ...c, x: c.x - deltaX / c.zoom, y: c.y - deltaY / c.zoom });
        gesture.current.moved ||= Math.hypot(point.x - gesture.current.start.x, point.y - gesture.current.start.y) > 4;
      }
      gesture.current.last = point; return;
    }
    // Touch has no hover: a tap focuses an island and the breadcrumb names it.
    if (event.pointerType === 'touch') return;
    let node = hitNode(point);
    const active = hoveredIdRef.current ? layout.nodeById.get(hoveredIdRef.current) : undefined;
    const activePoint = active ? worldToScreen(active, cameraRef.current, sizeRef.current.width, sizeRef.current.height) : undefined;
    // Retain the active hit target through its radius instead of flickering
    // between nearby files while crossing toward content.
    if (active && activePoint && filesTargetable() && Math.hypot(point.x - activePoint.x, point.y - activePoint.y) < fileHitRadius()) node = active;
    const tooltipBox = tooltipRef.current?.getBoundingClientRect(), canvasBox = canvasRef.current?.getBoundingClientRect();
    if (active && activePoint && node?.id !== active.id && tooltipBox && canvasBox) {
      const left = tooltipBox.left - canvasBox.left, top = tooltipBox.top - canvasBox.top;
      const inBridge = point.x >= Math.min(activePoint.x, left) - 4 && point.x <= Math.max(activePoint.x, left + tooltipBox.width) + 4 && point.y >= Math.min(activePoint.y, top) - 4 && point.y <= Math.max(activePoint.y, top + tooltipBox.height) + 4;
      if (inBridge) { hoverTriggerId.current = null; leaveHover(); return; }
    }
    hoverTriggerId.current = node?.id ?? null;
    if (node) {
      // A file hit always wins over the island under it.
      endIslandHover();
      if (dismissedHoverId.current === node.id) return;
      dismissedHoverId.current = null; cancelHoverLeave();
      // Anchor to the trigger entry point instead of chasing a pointer that is
      // crossing toward the tooltip content.
      if (hoveredIdRef.current !== node.id) { hoveredIdRef.current = node.id; setHoveredId(node.id); setHoverPosition(point); }
      return;
    }
    dismissedHoverId.current = null;
    const island = hitIsland(point);
    if (island) { if (hoveredIdRef.current) clearTooltip(); hoverIsland(island, point); }
    else { leaveHover(); leaveIsland(); }
  };
  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = eventPoint(event); const hadPointers = pointers.current.has(event.pointerId); pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!pointers.current.size) setDragging(false);
    if (hadPointers && !gesture.current.moved && event.type !== 'pointercancel') {
      const node = hitNode(point);
      const island = node ? undefined : hitIsland(point);
      if (node) onSelectFile(node.id);
      else if (island && island.id !== focusGroupId) { if (selectedFileId) onSelectFile(null); fitIsland(island.id); }
      else onSelectFile(null);
    }
    if (pointers.current.size === 1) { gesture.current.last = [...pointers.current.values()][0]; gesture.current.moved = true; }
    gesture.current.pinchDistance = null; gesture.current.pinchMidpoint = null;
  };
  const keyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const c = cameraRef.current; const amount = (event.shiftKey ? 140 : 60) / c.zoom;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); stopAnimation(); setCamera({ ...c, x: c.x + (event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0), y: c.y + (event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0) }); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.25); }
    else if (event.key === '-') { event.preventDefault(); zoom(.8); }
    else if (event.key === '0' || event.key === 'Home') { event.preventDefault(); fitAll(); }
    else if (event.key === 'Escape') { event.preventDefault(); onSelectFile(null); }
  };

  const repositionMinimap = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0) return;
    const rect = event.currentTarget.querySelector('svg')?.getBoundingClientRect();
    if (!rect) return;
    stopAnimation();
    const point = minimapPoint({ x: event.clientX, y: event.clientY }, { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, layout.bounds);
    setCamera({ ...cameraRef.current, ...point });
  };
  const minimapKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      pan(event.key === 'ArrowRight' ? 100 : event.key === 'ArrowLeft' ? -100 : 0, event.key === 'ArrowDown' ? 100 : event.key === 'ArrowUp' ? -100 : 0);
    } else if (event.key === 'Home' || event.key === '0') { event.preventDefault(); fitAll(); }
  };

  const visibleFiles = useMemo(() => layout.nodes.reduce((count, node) => count + Number((!scopeGroupId || node.groupId === scopeGroupId) && Math.abs((node.x - camera.x) * camera.zoom) < size.width / 2 + 25 && Math.abs((node.y - camera.y) * camera.zoom) < size.height / 2 + 25), 0), [layout.nodes, camera, size, scopeGroupId]);
  const suppressedEdges = useMemo(() => {
    if (!showImports) return snapshot.edges.length;
    if (snapshot.edges.length <= 10000 || camera.zoom >= .6) return 0;
    const focus = selectedFileId ?? hoveredId;
    return snapshot.edges.reduce((count, edge, index) => count + Number(index % 3 !== 0 && edge.source !== focus && edge.target !== focus), 0);
  }, [snapshot.edges, showImports, camera.zoom, selectedFileId, hoveredId]);
  const selectedIslandId = focusGroupId ?? (selectedFileId ? layout.nodeById.get(selectedFileId)?.groupId : undefined);

  // One keyboard surface: a focusable, named button per island in reading order.
  // The container is world-space (one transform per frame); buttons never move.
  const islandOrder = useMemo(() => layout.islands.filter(island => !scopeGroupId || island.id === scopeGroupId)
    .sort((a, b) => (a.y - a.ry) - (b.y - b.ry) || (a.x - a.rx) - (b.x - b.rx)), [layout.islands, scopeGroupId]);
  const activeIslandId = useMemo(() => {
    const has = (id: string | null | undefined) => !!id && islandOrder.some(island => island.id === id);
    if (has(rovingId)) return rovingId;
    if (has(focusGroupId)) return focusGroupId;
    return islandOrder.find(island => (islandStats.get(island.id)?.changed ?? 0) > 0)?.id ?? islandOrder[0]?.id ?? null;
  }, [islandOrder, rovingId, focusGroupId, islandStats]);
  const describedIslandId = islandTip?.via === 'keyboard' && !hovered ? islandTip.id : null;
  const focusIslandButton = useCallback((id: string) => {
    islandControlsRef.current?.querySelector<HTMLButtonElement>(`button[data-island-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }, []);
  const islandKeyDown = (event: KeyboardEvent<HTMLButtonElement>, island: Island) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const index = islandOrder.findIndex(entry => entry.id === island.id);
    let target: Island | undefined;
    if (event.key === 'ArrowRight') target = islandOrder[index + 1];
    else if (event.key === 'ArrowLeft') target = islandOrder[index - 1];
    else if (event.key === 'Home') target = islandOrder[0];
    else if (event.key === 'End') target = islandOrder[islandOrder.length - 1];
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // The nearest island by x in the next (previous) module row.
      const scale = layoutPitch(layout) / ISLAND_GEOMETRY.pitch, direction = event.key === 'ArrowDown' ? 1 : -1;
      const step = ISLAND_GEOMETRY.module * scale, gutter = ISLAND_GEOMETRY.gutter * scale;
      for (let probe = direction > 0 ? island.y + island.ry + gutter / 2 + step / 2 : island.y - island.ry - gutter / 2 - step / 2;
        probe > layout.bounds.y && probe < layout.bounds.y + layout.bounds.height && !target; probe += direction * step) {
        target = islandOrder.filter(entry => entry.y - entry.ry < probe && entry.y + entry.ry > probe)
          .sort((a, b) => Math.abs(a.x - island.x) - Math.abs(b.x - island.x))[0];
      }
    } else if (event.key === 'Escape') {
      // Escape clears the island focus, else the selected file, and keyboard focus stays on this
      // island: the page-level Escape (which returns focus to search or the last file trigger)
      // must not also run, or the place in the island list is lost.
      event.preventDefault(); event.stopPropagation();
      if (focusGroupId) onFocusGroup?.(null);
      else if (selectedFileId) onSelectFile(null);
      const target = event.currentTarget; requestAnimationFrame(() => { if (target.isConnected && document.activeElement !== target) target.focus({ preventScroll: true }); });
      return;
    }
    else return;
    event.preventDefault();
    if (target) focusIslandButton(target.id);
  };
  const islandFocused = (event: FocusEvent<HTMLButtonElement>, island: Island) => {
    setKeyboardIslandId(island.id); setRovingId(island.id);
    // One tooltip at a time: keyboard focus replaces any pointer hover content.
    clearTooltip(); cancelIslandTimers(); dismissedIslandId.current = null;
    setIslandTip({ id: island.id, point: { x: 0, y: 0 }, via: 'keyboard' });
    if (document.activeElement === event.target) ensureIslandVisible(island.id);
  };
  const islandBlurred = (island: Island) => {
    setKeyboardIslandId(current => current === island.id ? null : current);
    if (islandTipRef.current?.via === 'keyboard' && islandTipRef.current.id === island.id) setIslandTip(null);
  };
  // Buttons are memoised; their handlers read the latest closures through a ref.
  const islandHandlers = useRef({ focus: islandFocused, blur: islandBlurred, keyDown: islandKeyDown, activate: fitIsland });
  islandHandlers.current = { focus: islandFocused, blur: islandBlurred, keyDown: islandKeyDown, activate: fitIsland };
  const islandButtons = useMemo(() => islandOrder.map(island => {
    const stats = islandStats.get(island.id) ?? NO_STATS;
    return <button type="button" key={island.id} data-island-id={island.id} tabIndex={island.id === activeIslandId ? 0 : -1}
      className={`island-label ${focusGroupId === island.id ? 'is-focused' : ''}`}
      style={{ left: island.x - island.rx, top: island.y - island.ry, width: island.rx * 2, height: island.ry * 2, '--island-color': island.color } as CSSProperties}
      aria-label={`Explore ${island.label} island, ${stats.changed} changed of ${island.nodes.length} files`}
      aria-describedby={describedIslandId === island.id ? 'graph-island-tooltip' : undefined}
      onClick={() => islandHandlers.current.activate(island.id)} onFocus={event => islandHandlers.current.focus(event, island)} onBlur={() => islandHandlers.current.blur(island)} onKeyDown={event => islandHandlers.current.keyDown(event, island)}>
      <span className="island-title"><i />{island.label}</span><span className="island-meta">{stats.changed} changed <b>/</b> {island.nodes.length} files</span>
    </button>;
  }), [islandOrder, islandStats, activeIslandId, focusGroupId, describedIslandId]);

  const screenRect = (island: Island) => {
    const topLeft = worldToScreen({ x: island.x - island.rx, y: island.y - island.ry }, camera, size.width, size.height);
    return { x: topLeft.x, y: topLeft.y, width: island.rx * 2 * camera.zoom, height: island.ry * 2 * camera.zoom };
  };
  const ring = (id: string | null | undefined, state: 'hover' | 'focus' | 'keyboard') => {
    const island = id ? islandById.get(id) : undefined;
    if (!island || (scopeGroupId && island.id !== scopeGroupId)) return null;
    const rect = screenRect(island), offset = state === 'hover' ? 2 : 3;
    const radius = cornerRadius({ x: 0, y: 0, width: island.rx * 2, height: island.ry * 2 }, camera.zoom) + offset;
    return <div key={`${state}:${island.id}`} className="island-ring" data-state={state} aria-hidden="true" style={{ transform: `translate(${rect.x - offset}px, ${rect.y - offset}px)`, width: rect.width + offset * 2, height: rect.height + offset * 2, borderRadius: radius }} />;
  };
  const tipIsland = islandTip && !hovered && !dragging ? islandById.get(islandTip.id) : undefined;
  const tipStats = tipIsland ? islandStats.get(tipIsland.id) ?? NO_STATS : NO_STATS;
  const tipGroup = tipIsland ? snapshot.groups.find(group => group.id === tipIsland.id) as (GraphData['groups'][number] & { path?: unknown; origin?: unknown }) | undefined : undefined;
  const tipMeta = tipGroup ? islandTipMeta(tipGroup) : '';
  /** Tooltips open below the top band's backing (it ends 6 px under the strip; the inset adds 12). */
  const tipMinTop = Math.max(8, insets.top - 4);
  const tipPosition = (() => {
    if (!tipIsland || !islandTip) return { left: 0, top: 0 };
    // Clamped to the map between the chrome bands, never under the top band or the bottom bar.
    const maxLeft = Math.max(8, size.width - 308), maxTop = Math.max(tipMinTop, size.height - (insets.bottom - 12) - 8 - 96);
    if (islandTip.via === 'pointer') return { left: clamp(islandTip.point.x + 16, 8, maxLeft), top: clamp(islandTip.point.y + 18, tipMinTop, maxTop) };
    const rect = screenRect(tipIsland);
    return rect.height < 60 ? { left: clamp(rect.x, 8, maxLeft), top: clamp(rect.y + rect.height + 6, tipMinTop, maxTop) } : { left: clamp(rect.x + 8, 8, maxLeft), top: clamp(rect.y + 8, tipMinTop, maxTop) };
  })();
  const showMinimap = !compact || minimapOpen;
  const scopeStatus = `Showing ${scope.files.toLocaleString()} of ${scope.totalFiles.toLocaleString()} files · ${scope.edges.toLocaleString()} of ${scope.totalEdges.toLocaleString()} connections`;
  // Worded apart from the bar's own lines so each sentence stays unique on the page.
  const scopeNote = largeRepository ? `This map holds ${scope.totalFiles.toLocaleString()} files and ${scope.totalEdges.toLocaleString()} connections, more than the 2,000 files or 8,000 connections it is tuned for; ${scopeGroupId ? `the scope draws ${scope.files.toLocaleString()} files and ${scope.edges.toLocaleString()} connections` : 'all of them are drawn'}.` : undefined;
  const detail = <output className="graph-detail-summary" aria-label="Graph detail" aria-live="off" title={showImports && suppressedEdges > 0 ? `Overview detail: ${suppressedEdges.toLocaleString()} of ${snapshot.edges.length.toLocaleString()} background import lines suppressed. All ${snapshot.nodes.length.toLocaleString()} files are retained. Zoom in or inspect a file for its connections.` : undefined}>{visibleFiles.toLocaleString()} / {snapshot.nodes.length.toLocaleString()} files in view{showImports && suppressedEdges > 0 ? ` · ${suppressedEdges.toLocaleString()} import lines hidden at this zoom` : ''}</output>;

  const viewport = { x: camera.x - size.width / camera.zoom / 2, y: camera.y - size.height / camera.zoom / 2, width: size.width / camera.zoom, height: size.height / camera.zoom };
  return <div ref={hostRef} className={`constellation-graph ${dragging ? 'is-dragging' : ''} ${hoveredId || hoveredIslandId ? 'is-pointing' : ''} ${className}`} style={{ '--graph-inspector-width': `${inspectorWidth}px` } as CSSProperties} data-testid="graph-surface" data-layout-state={layoutState}>
    <canvas ref={canvasRef} data-testid="graph-canvas" data-camera-x={camera.x} data-camera-y={camera.y} data-camera-scale={camera.zoom} data-visible-file-count={visibleFiles} data-selection-cue={selectedFileId ? 'corner-brackets' : 'none'} className="constellation-canvas" tabIndex={0} aria-label={`Repository file graph. ${snapshot.nodes.length} files in ${layout.islands.length} islands. Arrow keys pan. Plus and minus zoom. Zero fits all islands. Use the Files view for accessible file details.`} aria-describedby="graph-instructions" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={pointerUp} onPointerLeave={() => { if (!pointers.current.size) { hoverTriggerId.current = null; dismissedHoverId.current = null; leaveHover(); leaveIsland(); } }} onKeyDown={keyDown} />
    <p id="graph-instructions" className="graph-sr-only">One circle is one file. Islands are rectangles sized by file count; a green border and a count mark islands with changes. Hover or focus an island to see its name and counts; Enter or a click focuses it. Green circles changed in the selected sources; an outer ring means multiple sources. Corner brackets identify the selected file. Lines are directed imports. Drag to pan, scroll or pinch to zoom. Control or Command modified wheel and keyboard shortcuts retain browser zoom. The synchronized Files view retains every file.</p>
    <div ref={islandControlsRef} role="group" className="island-controls" aria-label="Repository islands" style={{ transform: `translate(${size.width / 2 - camera.x * camera.zoom}px, ${size.height / 2 - camera.y * camera.zoom}px) scale(${camera.zoom})` }}>
      {islandButtons}
    </div>
    {ring(focusGroupId, keyboardIslandId && keyboardIslandId === focusGroupId ? 'keyboard' : 'focus')}
    {keyboardIslandId !== focusGroupId && ring(keyboardIslandId, 'keyboard')}
    {hoveredIslandId !== focusGroupId && hoveredIslandId !== keyboardIslandId && ring(hoveredIslandId, 'hover')}
    {hovered && !dragging && <div ref={tooltipRef} className="graph-tooltip" data-kind="file" role="tooltip" onPointerEnter={() => { tooltipHovered.current = true; cancelHoverLeave(); }} onPointerLeave={() => { tooltipHovered.current = false; leaveHover(); }} style={{ left: clamp(hoverPosition.x + 20, 8, Math.max(8, size.width - 285)), top: clamp(hoverPosition.y - 48, tipMinTop, Math.max(tipMinTop, Math.min(size.height - 130, size.height - (insets.bottom - 12) - 8 - 122))) }}><strong>{basename(hovered.path)}</strong><span>{hovered.path}</span><small>{membership.get(hovered.id) ? `${membership.get(hovered.id)} selected source${membership.get(hovered.id) === 1 ? '' : 's'}` : 'Unchanged context'} · Select circle to inspect</small></div>}
    {/* The island tooltip has nothing to click: pointer events pass through to the island under it. */}
    {tipIsland && <div ref={tooltipRef} id="graph-island-tooltip" className="graph-tooltip graph-island-tooltip" data-kind="island" role="tooltip" style={{ ...tipPosition, '--island-color': tipIsland.color } as CSSProperties}>
      <strong><i aria-hidden="true" />{tipIsland.label}</strong>
      <span className="tooltip-counts"><b className={tipStats.changed ? 'is-changed' : ''}>{tipStats.changed.toLocaleString()} changed</b> · {tipIsland.nodes.length.toLocaleString()} files{tipStats.overlap ? ` · ${tipStats.overlap.toLocaleString()} in multiple ${sourceKind === 'commit' ? 'commits' : 'PRs'}` : ''}</span>
      {tipMeta && <span className="tooltip-path">{tipMeta}</span>}
      <small>Click or Enter to focus island</small>
    </div>}
    {layoutState === 'pending' && <div className="graph-layout-status" role="status">Settling repository islands…</div>}
    {(canvasFailed || layoutState === 'failed') && <div className="graph-canvas-error" role="status"><strong>Graph rendering is unavailable</strong><p>{layoutError || 'Use Files to explore the complete repository and its connections.'}</p>{onOpenFiles && <button type="button" onClick={onOpenFiles}>Open file list</button>} {layoutState === 'failed' && <button type="button" onClick={resetLayout}>Retry layout</button>} {canvasFailed && <button type="button" onClick={() => { const available = !!canvasRef.current?.getContext('2d'); setCanvasFailed(!available); if (available) { setCanvasAttempt(value => value + 1); requestDraw(); } }}>Retry graph</button>}</div>}
    {barHost && createPortal(<div ref={barRef} className={`graph-bottom-bar panel ${largeRepository ? 'has-scope' : ''}`} style={{ '--graph-inspector-width': `${inspectorWidth}px` } as CSSProperties}>
      {legend ? legend(detail, scopeNote) : <div className="graph-legend">{detail}</div>}
      {largeRepository && <div role="group" className="graph-scope-control" aria-label="Large repository scope">
        <label htmlFor="graph-scope"><span className="graph-scope-label">Explore scope</span> <select id="graph-scope" aria-label="Explore scope" title={`${scopeStatus}. Above the 2,000-file / 8,000-connection target.`} value={scopeGroupId ?? ''} onChange={event => {
          const id = event.target.value || null; setScopeGroupId(id); onFocusGroup?.(id);
          const island = id ? layout.islands.find(group => group.id === id) : undefined;
          moveCamera(fitBounds(island ? islandBounds(island) : layout.bounds));
        }}><option value="">All islands</option>{snapshot.groups.map(group => <option value={group.id} key={group.id}>{group.label}</option>)}</select></label>
        {/* Below 1500 px (desktop) these two lines collapse into the select's title and the ? explanation. */}
        <span role="status" className="graph-scope-status">{scopeStatus}</span>
        <small className="graph-scope-target">Above the 2,000-file / 8,000-connection target.</small>
      </div>}
      <div role="group" className="graph-navigation" aria-label="Graph navigation">
        <div className="graph-zoom-bar">
          <button type="button" onClick={() => zoom(.8)} aria-label="Zoom out" title="Zoom out (−)">−</button><output aria-label="Graph zoom" data-testid="zoom-level">{Math.round(camera.zoom / fit.zoom * 100)}%</output><button type="button" onClick={() => zoom(1.25)} aria-label="Zoom in" title="Zoom in (+)">+</button>
          <span className="graph-nav-divider" />
          <button type="button" className="graph-fit-button" onClick={fitAll} aria-label="Fit all islands" title="Fit all islands (0)"><FitIcon /> Fit</button>
          {selectedIslandId && <button className="graph-fit-island" type="button" onClick={() => fitIsland(selectedIslandId)} aria-label="Fit selected island" title="Fit selected island"><FitIslandIcon /></button>}
          <span className="graph-nav-divider" />
          <button type="button" onClick={() => pan(0, -80)} aria-label="Pan up" title="Pan up">↑</button><button type="button" onClick={() => pan(0, 80)} aria-label="Pan down" title="Pan down">↓</button><button type="button" className="graph-pan-x" onClick={() => pan(-80, 0)} aria-label="Pan left" title="Pan left">‹</button><button type="button" className="graph-pan-x" onClick={() => pan(80, 0)} aria-label="Pan right" title="Pan right">›</button>
          <span className="graph-nav-divider" />
          <button type="button" className="graph-reset-layout" onClick={resetLayout} disabled={layoutState === 'pending'} aria-label="Reset island layout" title="Reset island layout"><ResetIcon /></button>
          {compact && <button type="button" className="graph-map-toggle" onClick={() => setMinimapOpen(open => !open)} aria-pressed={minimapOpen} aria-label="Minimap" title={minimapOpen ? 'Hide minimap' : 'Show minimap'}><MapIcon /> Map</button>}
        </div>
      </div>
      {showMinimap && <button className="graph-minimap" type="button" title="Repository minimap. Click to pan, arrows to move, Home to fit." aria-label="Repository minimap. Click to reposition. Arrow keys pan the graph." onClick={repositionMinimap} onKeyDown={minimapKeyDown}>
        <svg viewBox={`${layout.bounds.x} ${layout.bounds.y} ${layout.bounds.width} ${layout.bounds.height}`} preserveAspectRatio="none" aria-hidden="true">{layout.islands.map(island => <rect key={island.id} x={island.x - island.rx} y={island.y - island.ry} width={island.rx * 2} height={island.ry * 2} rx={Math.min(island.rx, island.ry) * .12} fill={(islandStats.get(island.id)?.changed ?? 0) > 0 ? '#42b968cc' : alpha(island.color, '73')} />)}<rect className="graph-minimap-viewport" {...minimapFrame(viewport, layout.bounds, MINIMAP_PIXELS)} fill="#a2f4ba14" stroke="#a2f4ba" strokeWidth={1.25} vectorEffect="non-scaling-stroke" /></svg>
      </button>}
    </div>, barHost)}
  </div>;
}

function hashEdge(value: string) { let hash = 0; for (let i = 0; i < value.length; i++) hash = Math.imul(hash, 31) + value.charCodeAt(i); return hash >>> 0; }
function intersects(a: Bounds, b: Bounds) { return a.x < b.x + b.width + 4 && a.x + a.width + 4 > b.x && a.y < b.y + b.height + 3 && a.y + a.height + 3 > b.y; }
function FitIcon() { return <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M6 3H3v3m9-3h3v3M3 12v3h3m9-3v3h-3" /></svg>; }
function FitIslandIcon() { return <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M6 3H3v3m9-3h3v3M3 12v3h3m9-3v3h-3" /><rect x="6.5" y="6.5" width="5" height="5" rx="1" /></svg>; }
function ResetIcon() { return <svg viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 9a5.5 5.5 0 1 0 1.7-4" /><path d="M3.5 3.2V6.5h3.3" /></svg>; }
function MapIcon() { return <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><rect x="2.5" y="3.5" width="13" height="11" rx="1.5" /><rect x="5" y="6" width="5" height="4" rx=".6" /></svg>; }
