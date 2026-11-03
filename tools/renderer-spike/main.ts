import Graph from 'graphology';
import Sigma from 'sigma';
import { pathCurved, extremityArrow } from 'sigma/rendering';
import { createDemoSnapshot, createScaleFixture } from '../../packages/fixtures/src/index';
import { layoutGraph, selectedMembership } from '../../packages/graph-core/src/index';

// The candidate consumes positioned domain data; it never owns layout or source facts.
const parameters = new URLSearchParams(location.search);
const files = parameters.get('files') === '2000' ? 2000 : 212;
const snapshot = files === 212 ? createDemoSnapshot() : createScaleFixture(2000, 8000, 42);
const layout = layoutGraph(snapshot);
const membership = selectedMembership(snapshot, snapshot.sources.map(source => source.id));
const graph = new Graph({ type: 'directed', multi: true });
const surface = document.querySelector<HTMLElement>('#surface')!;
const fallback = document.querySelector<HTMLElement>('#fallback')!;
const status = document.querySelector<HTMLOutputElement>('#status')!;
let selected: string | null = null, renderer: Sigma | null = null;
let renderCount = 0;
const starts = performance.now();
for (const node of layout.nodes) graph.addNode(node.id, { x: node.x, y: -node.y, size: 5, label: node.path, color: membership.has(node.id) ? '#42b968' : '#52686d' });
for (const edge of snapshot.edges) graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, { size: .55, label: edge.kind, color: '#3c575c' });
for (const node of layout.nodes) {
  const li = document.createElement('li'), button = document.createElement('button');
  button.textContent = `${node.path} · ${membership.get(node.id) ?? 0} sources · ${snapshot.edges.filter(edge => edge.source === node.id || edge.target === node.id).length} imports`;
  button.onclick = () => { selected = node.id; renderer?.refresh(); drawLayers(); };
  li.append(button); document.querySelector('#file-list')!.append(li);
}
for (const island of layout.islands) {
  const label = document.createElement('span'); label.className = 'island-label'; label.dataset.island = island.id; label.textContent = `${island.label} · ${island.nodes.length} files`;
  document.querySelector('#labels')!.append(label);
}
function drawLayers() {
  if (!renderer) return;
  const rect = surface.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  const back = document.querySelector<HTMLCanvasElement>('#islands')!, rings = document.querySelector<HTMLCanvasElement>('#rings')!;
  for (const canvas of [back, rings]) {
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) { canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); }
    canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
  }
  const context = back.getContext('2d')!, foreground = rings.getContext('2d')!;
  // Sigma owns normalization, aspect ratio, Y orientation and camera transforms.
  // Sampling its conversion keeps both Canvas layers aligned at every zoom.
  const convert = (x: number, y: number) => renderer!.graphToViewport({ x, y: -y });
  for (const island of layout.islands) {
    const center = convert(island.x, island.y), east = convert(island.x + island.rx, island.y), south = convert(island.x, island.y + island.ry);
    const rx = Math.abs(east.x - center.x), ry = Math.abs(south.y - center.y);
    context.beginPath(); context.moveTo(center.x - rx, center.y);
    context.bezierCurveTo(center.x - rx * 1.1, center.y - ry, center.x + rx * .85, center.y - ry * 1.1, center.x + rx, center.y);
    context.bezierCurveTo(center.x + rx * 1.15, center.y + ry, center.x - rx * .95, center.y + ry * 1.1, center.x - rx, center.y);
    context.fillStyle = island.color + '16'; context.strokeStyle = island.color + '70'; context.fill(); context.stroke();
    const label = document.querySelector<HTMLElement>(`[data-island="${island.id}"]`)!;
    label.style.left = `${center.x - rx * .8}px`; label.style.top = `${center.y - ry * .85}px`;
  }
  for (const node of layout.nodes) {
    if ((membership.get(node.id) ?? 0) <= 1 && selected !== node.id) continue;
    const point = convert(node.x, node.y); foreground.beginPath(); foreground.arc(point.x, point.y, selected === node.id ? 11 : 8.5, 0, Math.PI * 2); foreground.strokeStyle = selected === node.id ? '#ffffff' : '#d7e8de'; foreground.lineWidth = selected === node.id ? 2 : 1; foreground.stroke();
  }
}
function mount() {
  try {
    renderer?.kill(); renderer = null;
    renderer = new Sigma(graph, document.querySelector<HTMLElement>('#sigma')!, {
      settings: { labelRenderedSizeThreshold: 7, hideLabelsOnMove: true, enableCameraRotation: false, nodePickingPadding: 4, stagePadding: 80 },
      primitives: { edges: { paths: [pathCurved({ curvature: .08 })], extremities: [extremityArrow()] } },
      styles: { edges: { path: 'curved', head: 'arrow', color: { attribute: 'color', defaultValue: '#3c575c' }, opacity: attrs => attrs.focused ? 1 : .22, size: .55 } },
    });
    renderer.setCustomBBox({ x: [layout.bounds.x, layout.bounds.x + layout.bounds.width], y: [-layout.bounds.y - layout.bounds.height, -layout.bounds.y] });
    renderer.on('clickNode', ({ node }) => {
      selected = node; status.value = snapshot.nodes.find(file => file.id === node)!.path;
      graph.forEachEdge((key, _attrs, from, to) => { const focused = from === selected || to === selected; graph.mergeEdgeAttributes(key, { color: focused ? '#a2f4ba' : '#3c575c', focused }); });
      renderer!.refresh(); drawLayers();
    });
    renderer.on('afterRender', () => { renderCount++; drawLayers(); });
    renderer.getCamera().on('updated', drawLayers);
    renderer.refresh(); drawLayers(); fallback.hidden = true; status.value = `${graph.order} files · ${graph.size} imports`;
    (window as any).spike = { renderer, graph, layout, membership, startedAt: starts, get renderCount() { return renderCount; }, ready: true };
  } catch (error) {
    status.value = 'Graph unavailable. The complete file list remains available.'; fallback.hidden = false;
    (window as any).spike = { ready: false, error: String(error), files: graph.order };
  }
}
document.querySelector<HTMLButtonElement>('#out')!.onclick = () => renderer?.getCamera().zoomOut();
document.querySelector<HTMLButtonElement>('#in')!.onclick = () => renderer?.getCamera().zoomIn();
document.querySelector<HTMLButtonElement>('#fit')!.onclick = () => renderer?.getCamera().reset();
document.querySelector<HTMLButtonElement>('#files')!.onclick = () => { fallback.hidden = !fallback.hidden; };
document.querySelector<HTMLButtonElement>('#close')!.onclick = () => { fallback.hidden = true; };
document.querySelector<HTMLButtonElement>('#retry')!.onclick = mount;
window.addEventListener('resize', drawLayers);
window.addEventListener('pagehide', () => { renderer?.kill(); window.removeEventListener('resize', drawLayers); });
mount();
