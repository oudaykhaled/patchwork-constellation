import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { fitCamera, islandBounds, neighborsOf, selectedMembership, worldToScreen, zoomAt } from '../../../../packages/graph-core/src/index';
import type { Bounds, Camera, GraphData, Island, Point, PositionedFile } from '../../../../packages/graph-core/src/index';
import { useSettledLayout } from './useSettledLayout';
import './constellation-graph.css';

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
  className?: string;
  layoutSeed?: number;
  layoutPins?: Record<string, Point>;
}

type Size = { width: number; height: number };
const EMPTY_SIZE: Size = { width: 1600, height: 936 };
const DEFAULT_CAMERA: Camera = { x: 800, y: 468, zoom: 1 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const basename = (path: string) => path.split('/').pop() ?? path;
const alpha = (color: string, opacity: string) => /^#[0-9a-f]{6}$/i.test(color) ? color + opacity : '#66bfa0' + opacity;

/** A bounded organic island outline. Every contained dot is still an individual file. */
function islandPath(context: CanvasRenderingContext2D, island: Island) {
  const { x, y, rx, ry } = island;
  context.beginPath();
  context.moveTo(x - rx * .97, y - ry * .06);
  context.bezierCurveTo(x - rx * 1.2, y - ry * .91, x - rx * .57, y - ry * 1.12, x + rx * .05, y - ry);
  context.bezierCurveTo(x + rx * .72, y - ry * 1.03, x + rx * 1.08, y - ry * .65, x + rx * .98, y - ry * .02);
  context.bezierCurveTo(x + rx * 1.13, y + ry * .64, x + rx * .6, y + ry * 1.02, x + rx * .06, y + ry * .97);
  context.bezierCurveTo(x - rx * .5, y + ry * 1.12, x - rx * 1.08, y + ry * .73, x - rx * .97, y - ry * .06);
  context.closePath();
}

export function ConstellationGraph({ snapshot, selectedSourceIds, selectedFileId, onSelectFile, focusGroupId, onFocusGroup, searchQuery = '', showImports = true, onOpenFiles, className = '', layoutSeed = 0, layoutPins }: ConstellationGraphProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<Camera>(DEFAULT_CAMERA);
  const sizeRef = useRef(EMPTY_SIZE);
  const animationRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Point; last: Point; moved: boolean; pinchDistance: number | null }>({ start: { x: 0, y: 0 }, last: { x: 0, y: 0 }, moved: false, pinchDistance: null });
  const [size, setSize] = useState(EMPTY_SIZE);
  const [camera, setCameraState] = useState(DEFAULT_CAMERA);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoverPosition, setHoverPosition] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [canvasFailed, setCanvasFailed] = useState(false);
  const [canvasAttempt, setCanvasAttempt] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const { layout, layoutState, layoutError, resetLayout } = useSettledLayout(snapshot, layoutSeed, layoutPins);
  const framedRepository = useRef<string | null>(null);
  const membership = useMemo(() => selectedMembership(snapshot, selectedSourceIds), [snapshot, selectedSourceIds]);
  const neighbors = useMemo(() => neighborsOf(snapshot.edges, selectedFileId), [snapshot.edges, selectedFileId]);
  const search = searchQuery.trim().toLowerCase();
  const selectedPosition = selectedFileId ? layout.nodeById.get(selectedFileId) : undefined;
  const focusedIsland = focusGroupId ? layout.islands.find(island => island.id === focusGroupId) : undefined;
  const hovered = hoveredId ? layout.nodeById.get(hoveredId) : undefined;
  const fit = useMemo(() => fitCamera(layout.bounds, size.width, size.height, 12), [layout.bounds, size]);
  const latest = useRef({ layout, snapshot, membership, neighbors, selectedFileId, hoveredId, search, showImports });
  latest.current = { layout, snapshot, membership, neighbors, selectedFileId, hoveredId, search, showImports };

  const draw = useCallback(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const { width, height } = sizeRef.current;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const c = cameraRef.current;
    const data = latest.current;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#091216'; context.fillRect(0, 0, width, height);
    // Screen-space grid deliberately remains subtle throughout zooming.
    const grid = clamp(32 * c.zoom, 19, 42);
    const offsetX = ((width / 2 - c.x * c.zoom) % grid + grid) % grid;
    const offsetY = ((height / 2 - c.y * c.zoom) % grid + grid) % grid;
    context.fillStyle = '#16272a';
    for (let x = offsetX; x < width; x += grid) for (let y = offsetY; y < height; y += grid) context.fillRect(x, y, 1.2, 1.2);
    context.translate(width / 2, height / 2); context.scale(c.zoom, c.zoom); context.translate(-c.x, -c.y);
    const visible = (node: Point, extra = 25) => Math.abs((node.x - c.x) * c.zoom) < width / 2 + extra && Math.abs((node.y - c.y) * c.zoom) < height / 2 + extra;
    for (const island of data.layout.islands) {
      islandPath(context, island);
      context.fillStyle = alpha(island.color, data.selectedFileId && !island.nodes.some(node => node.id === data.selectedFileId) ? '04' : '07');
      context.fill(); context.strokeStyle = alpha(island.color, '45'); context.lineWidth = .8 / c.zoom; context.stroke();
    }
    const focusedEdges: typeof data.snapshot.edges = [];
    context.lineWidth = .68 / c.zoom; context.strokeStyle = '#3c575c66'; context.beginPath();
    const suppressEdges = data.snapshot.edges.length > 10000 && c.zoom < .6;
    data.snapshot.edges.forEach((edge, i) => {
      if (!data.showImports) return;
      const from = data.layout.nodeById.get(edge.source); const to = data.layout.nodeById.get(edge.target);
      if (!from || !to) return;
      if (data.selectedFileId && (from.id === data.selectedFileId || to.id === data.selectedFileId)) { focusedEdges.push(edge); return; }
      if ((suppressEdges && i % 3 !== 0) || (!visible(from, 120) && !visible(to, 120))) return;
      context.moveTo(from.x, from.y);
      const curve = (hashEdge(edge.id) % 2 ? 1 : -1) * Math.min(25, Math.abs(from.x - to.x) * .12);
      context.quadraticCurveTo((from.x + to.x) / 2 + curve, (from.y + to.y) / 2 - curve, to.x, to.y);
    });
    context.globalAlpha = data.selectedFileId ? .24 : 1; context.stroke(); context.globalAlpha = 1;
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
    const labels: { node: PositionedFile; priority: number }[] = [];
    for (const node of data.layout.nodes) {
      if (!visible(node)) continue;
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
      if (count > 1 || isSelected || isNeighbor || node.id === data.hoveredId || isSearch) {
        context.beginPath(); context.arc(node.x, node.y, radius + 3.6 / c.zoom, 0, Math.PI * 2);
        context.strokeStyle = isSelected ? '#e1ffec' : count > 1 ? '#d7e8de' : '#8bc7a5'; context.lineWidth = (isSelected ? 1.6 : 1) / c.zoom; context.stroke();
      }
      context.globalAlpha = 1;
      if (isSelected || isSearch || node.id === data.hoveredId || (isNeighbor && c.zoom > .7) || (c.zoom > 1.25 && count)) labels.push({ node, priority: isSelected ? 0 : isSearch ? 1 : isNeighbor ? 2 : 3 });
    }
    // Draw a few contextual labels in overview and more labels at semantic zoom.
    if (c.zoom <= 1.25 && !data.selectedFileId && !data.search) for (const island of data.layout.islands) {
      const representative = island.nodes.find(node => data.membership.has(node.id)) ?? island.nodes[0];
      if (representative) labels.push({ node: representative, priority: 4 });
    }
    const boxes: Bounds[] = [];
    context.font = `${10 / c.zoom}px 'Geist Mono', 'SFMono-Regular', Consolas, monospace`;
    labels.sort((a, b) => a.priority - b.priority).slice(0, 100).forEach(({ node, priority }) => {
      const label = basename(node.path); const textWidth = context.measureText(label).width;
      const box = { x: node.x + 15 / c.zoom, y: node.y - 12 / c.zoom, width: textWidth + 15 / c.zoom, height: 24 / c.zoom };
      if (!visible(node, -10) || (priority > 0 && boxes.some(b => intersects(b, box)))) return;
      boxes.push(box); context.fillStyle = '#0a1217ef'; context.fillRect(box.x, box.y, box.width, box.height);
      context.fillStyle = priority < 3 ? '#dcebe4' : '#a2b1aa'; context.fillText(label, box.x + 7 / c.zoom, box.y + 15 / c.zoom);
    });
  }, []);

  const requestDraw = useCallback(() => { if (frameRef.current === null) frameRef.current = requestAnimationFrame(draw); }, [draw]);
  const setCamera = useCallback((next: Camera) => {
    cameraRef.current = next; setCameraState(next); requestDraw();
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
  const fitAll = useCallback(() => { onFocusGroup?.(null); moveCamera(fitCamera(layout.bounds, sizeRef.current.width, sizeRef.current.height, 12)); }, [layout.bounds, moveCamera, onFocusGroup]);
  const zoom = useCallback((factor: number, anchor?: Point) => {
    stopAnimation(); const { width, height } = sizeRef.current; const c = cameraRef.current;
    setCamera(zoomAt(c, clamp(c.zoom * factor, fit.zoom * .32, Math.max(4.8, fit.zoom * 8)), anchor ?? { x: width / 2, y: height / 2 }, width, height));
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
    const host = hostRef.current; const canvas = canvasRef.current;
    if (!host || !canvas) return;
    if (!canvas.getContext('2d')) { setCanvasFailed(true); return; }
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect; if (!rect.width || !rect.height) return;
      const nextSize = { width: rect.width, height: rect.height }; const first = sizeRef.current === EMPTY_SIZE;
      sizeRef.current = nextSize; setSize(nextSize);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
      if (first) setCamera(fitCamera(latest.current.layout.bounds, rect.width, rect.height, 12)); else requestDraw();
    });
    observer.observe(host); return () => observer.disconnect();
  }, [requestDraw, setCamera, canvasAttempt]);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const lost = (event: Event) => { event.preventDefault(); setCanvasFailed(true); };
    const restored = () => { setCanvasFailed(false); setCanvasAttempt(value => value + 1); requestDraw(); };
    canvas.addEventListener('contextlost', lost); canvas.addEventListener('contextrestored', restored);
    return () => { canvas.removeEventListener('contextlost', lost); canvas.removeEventListener('contextrestored', restored); };
  }, [requestDraw]);
  // A source response can replace arrays while retaining the same context snapshot.
  // Only a new snapshot/grouping key resets framing; source toggles never do.
  useEffect(() => {
    if (layoutState !== 'ready') return;
    const repository = snapshot.repository?.fullName ?? snapshot.id ?? 'graph';
    if (framedRepository.current === repository) return;
    framedRepository.current = repository;
    moveCamera(fitCamera(latest.current.layout.bounds, sizeRef.current.width, sizeRef.current.height, 12), false);
  }, [snapshot.id, snapshot.repository?.fullName, layoutState, moveCamera]);
  useEffect(() => { requestDraw(); }, [layout, snapshot.edges, membership, neighbors, selectedFileId, hoveredId, search, showImports, requestDraw]);
  useEffect(() => {
    if (!focusGroupId) return;
    const island = layout.islands.find(group => group.id === focusGroupId);
    if (island) moveCamera(fitCamera(islandBounds(island), sizeRef.current.width, sizeRef.current.height, 130));
  }, [focusGroupId, focusedIsland?.x, focusedIsland?.y, focusedIsland?.rx, focusedIsland?.ry, moveCamera]);
  useEffect(() => {
    if (!selectedFileId) return;
    const node = layout.nodeById.get(selectedFileId); if (!node) return;
    const current = cameraRef.current;
    moveCamera({ ...current, x: node.x + (window.innerWidth > 900 ? 90 : 0) / current.zoom, y: node.y, zoom: Math.max(current.zoom, fit.zoom * 1.75) });
  }, [selectedFileId, selectedPosition?.x, selectedPosition?.y, moveCamera]);
  useEffect(() => () => {
    stopAnimation();
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    // React StrictMode deliberately mounts effects twice. A cancelled frame is
    // no longer scheduled and must not prevent the remounted effect drawing.
    frameRef.current = null;
    pointers.current.clear();
  }, [stopAnimation]);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      // Browser zoom remains available via Ctrl/Cmd +/− outside the graph.
      event.preventDefault(); const rect = canvas.getBoundingClientRect();
      zoom(Math.exp(-clamp(event.deltaY, -180, 180) * .003), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    canvas.addEventListener('wheel', wheel, { passive: false }); return () => canvas.removeEventListener('wheel', wheel);
  }, [zoom]);

  const eventPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => { const rect = event.currentTarget.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const hitNode = (point: Point) => {
    let found: PositionedFile | undefined; let best = 16;
    for (const node of layout.nodes) { const screen = worldToScreen(node, cameraRef.current, sizeRef.current.width, sizeRef.current.height); const distance = Math.hypot(screen.x - point.x, screen.y - point.y); if (distance < best) { found = node; best = distance; } }
    return found;
  };
  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    stopAnimation(); const point = eventPoint(event); pointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus();
    gesture.current = { start: point, last: point, moved: pointers.current.size > 1, pinchDistance: null }; setDragging(true); setHoveredId(null);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = eventPoint(event);
    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, point);
      const points = [...pointers.current.values()];
      if (points.length >= 2) {
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        if (gesture.current.pinchDistance) zoom(distance / gesture.current.pinchDistance, { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
        gesture.current.pinchDistance = distance; gesture.current.moved = true;
      } else {
        const deltaX = point.x - gesture.current.last.x, deltaY = point.y - gesture.current.last.y;
        const c = cameraRef.current; setCamera({ ...c, x: c.x - deltaX / c.zoom, y: c.y - deltaY / c.zoom });
        gesture.current.moved ||= Math.hypot(point.x - gesture.current.start.x, point.y - gesture.current.start.y) > 4;
      }
      gesture.current.last = point; return;
    }
    const node = hitNode(point); setHoveredId(node?.id ?? null); if (node) setHoverPosition(point);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = eventPoint(event); const hadPointers = pointers.current.has(event.pointerId); pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!pointers.current.size) setDragging(false);
    if (hadPointers && !gesture.current.moved && event.type !== 'pointercancel') { const node = hitNode(point); onSelectFile(node?.id ?? null); }
    if (pointers.current.size === 1) { gesture.current.last = [...pointers.current.values()][0]; gesture.current.moved = true; }
    gesture.current.pinchDistance = null;
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

  const viewport = { x: camera.x - size.width / camera.zoom / 2, y: camera.y - size.height / camera.zoom / 2, width: size.width / camera.zoom, height: size.height / camera.zoom };
  return <div ref={hostRef} className={`constellation-graph ${dragging ? 'is-dragging' : ''} ${className}`} data-testid="graph-surface">
    <canvas ref={canvasRef} data-testid="graph-canvas" data-camera-x={camera.x} data-camera-y={camera.y} data-camera-scale={camera.zoom} className="constellation-canvas" tabIndex={0} aria-label={`Repository file graph. ${snapshot.nodes.length} files in ${layout.islands.length} islands. Arrow keys pan. Plus and minus zoom. Zero fits all islands. Use the Files view for accessible file details.`} aria-describedby="graph-instructions" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onPointerLeave={() => !pointers.current.size && setHoveredId(null)} onKeyDown={keyDown} />
    <p id="graph-instructions" className="graph-sr-only">One circle is one file. Green circles changed in the selected sources; an outer ring means multiple sources. Lines are directed imports. Drag to pan, scroll or pinch to zoom. Select a labeled island to focus it. Keyboard navigation and a synchronized file list are available.</p>
    <div className="island-controls" aria-label="Repository islands">
      {layout.islands.map(island => {
        const point = worldToScreen({ x: island.x - island.rx * .78, y: island.y - island.ry * .82 }, camera, size.width, size.height);
        const count = island.nodes.reduce((total, node) => total + Number(membership.has(node.id)), 0);
        const offscreen = point.x < -180 || point.x > size.width || point.y < 0 || point.y > size.height - 50;
        return <button type="button" key={island.id} className={`island-label ${focusGroupId === island.id ? 'is-focused' : ''}`} style={{ left: point.x, top: point.y, visibility: offscreen ? 'hidden' : undefined, '--island-color': island.color } as CSSProperties} onClick={() => { onFocusGroup?.(island.id); moveCamera(fitCamera(islandBounds(island), size.width, size.height, 130)); }} aria-label={`Explore ${island.label} island, ${count} changed of ${island.nodes.length} files`}>
          <span className="island-title"><i />{island.label}</span><span className="island-meta">{count} changed <b>/</b> {island.nodes.length} files</span>
        </button>;
      })}
    </div>
    {hovered && !dragging && <div className="graph-tooltip" role="tooltip" style={{ left: Math.min(hoverPosition.x + 20, size.width - 285), top: Math.max(8, hoverPosition.y - 48) }}><strong>{basename(hovered.path)}</strong><span>{hovered.path}</span><small>{membership.get(hovered.id) ? `${membership.get(hovered.id)} selected source${membership.get(hovered.id) === 1 ? '' : 's'}` : 'Unchanged context'} · Click to inspect</small></div>}
    {layoutState === 'pending' && <div className="graph-layout-status" role="status">Settling repository islands…</div>}
    {(canvasFailed || layoutState === 'failed') && <div className="graph-canvas-error" role="status"><strong>Graph rendering is unavailable</strong><p>{layoutError || 'Use Files to explore the complete repository and its connections.'}</p>{onOpenFiles && <button type="button" onClick={onOpenFiles}>Open file list</button>} {layoutState === 'failed' && <button type="button" onClick={resetLayout}>Retry layout</button>} {canvasFailed && <button type="button" onClick={() => { const available = !!canvasRef.current?.getContext('2d'); setCanvasFailed(!available); if (available) { setCanvasAttempt(value => value + 1); requestDraw(); } }}>Retry graph</button>}</div>}
    {snapshot.edges.length > 10000 && camera.zoom < .6 && <div className="graph-detail-notice">Overview detail: one third of import lines shown. All {snapshot.nodes.length.toLocaleString()} files are retained. Zoom in for connections.</div>}
    <div className="graph-navigation" aria-label="Graph navigation">
      <button type="button" className="graph-reset-layout" onClick={resetLayout} disabled={layoutState === 'pending'}>Reset island layout</button>
      <span className="graph-pan-hint">Drag to pan · scroll to zoom</span>
      <button className="graph-minimap" type="button" title="Repository minimap. Click to pan, arrows to move." aria-label="Repository minimap. Click to reposition. Arrow keys pan the graph." onClick={event => { if (event.detail === 0) return; stopAnimation(); const rect = event.currentTarget.getBoundingClientRect(); setCamera({ ...cameraRef.current, x: layout.bounds.x + (event.clientX - rect.left) / rect.width * layout.bounds.width, y: layout.bounds.y + (event.clientY - rect.top) / rect.height * layout.bounds.height }); }} onKeyDown={event => { if (event.key.startsWith('Arrow')) { event.preventDefault(); stopAnimation(); const c = cameraRef.current; setCamera({ ...c, x: c.x + (event.key === 'ArrowRight' ? 100 : event.key === 'ArrowLeft' ? -100 : 0) / c.zoom, y: c.y + (event.key === 'ArrowDown' ? 100 : event.key === 'ArrowUp' ? -100 : 0) / c.zoom }); } }}>
        <svg viewBox={`${layout.bounds.x} ${layout.bounds.y} ${layout.bounds.width} ${layout.bounds.height}`} preserveAspectRatio="none" aria-hidden="true">{layout.islands.map(island => <ellipse key={island.id} cx={island.x} cy={island.y} rx={island.rx} ry={island.ry} fill={alpha(island.color, '77')} />)}<rect x={viewport.x} y={viewport.y} width={viewport.width} height={viewport.height} fill="none" stroke="#a2f4ba" strokeWidth={10} /></svg>
      </button>
      <div className="graph-zoom-bar">
        <button type="button" onClick={() => zoom(.8)} aria-label="Zoom out" title="Zoom out (−)">−</button><output aria-label="Graph zoom" data-testid="zoom-level">{Math.round(camera.zoom / fit.zoom * 100)}%</output><button type="button" onClick={() => zoom(1.25)} aria-label="Zoom in" title="Zoom in (+)">+</button><span className="graph-nav-divider" /><button type="button" className="graph-fit-button" onClick={fitAll} aria-label="Fit all islands" title="Fit all islands (0)"><FitIcon /> Fit</button><span className="graph-nav-divider" /><button type="button" onClick={() => pan(0, -80)} aria-label="Pan up" title="Pan up">↑</button><button type="button" onClick={() => pan(0, 80)} aria-label="Pan down" title="Pan down">↓</button><button type="button" onClick={() => pan(-80, 0)} aria-label="Pan left" title="Pan left">‹</button><button type="button" onClick={() => pan(80, 0)} aria-label="Pan right" title="Pan right">›</button>
      </div>
    </div>
  </div>;
}

function hashEdge(value: string) { let hash = 0; for (let i = 0; i < value.length; i++) hash = Math.imul(hash, 31) + value.charCodeAt(i); return hash >>> 0; }
function intersects(a: Bounds, b: Bounds) { return a.x < b.x + b.width + 4 && a.x + a.width + 4 > b.x && a.y < b.y + b.height + 3 && a.y + a.height + 3 > b.y; }
function FitIcon() { return <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M6 3H3v3m9-3h3v3M3 12v3h3m9-3v3h-3" /></svg>; }
