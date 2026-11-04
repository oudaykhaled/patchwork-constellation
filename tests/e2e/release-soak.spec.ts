import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { createDemoSnapshot, createScaleFixture } from '../../packages/fixtures/src/index';
import { layoutGraph, layoutPitch } from '../../packages/graph-core/src/index';

type Probe = {
  workersCreated: number; workersTerminated: number; workersLive: number; workersPeak: number;
  globalListeners: number; longTasks: number[];
};
type MeasuredWindow = Window & { __releaseProbe: Probe };

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => structuredClone((window as unknown as MeasuredWindow).__releaseProbe));
}

async function paintedFiles(page: Page) {
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(element => {
    const target = element as HTMLCanvasElement, context = target.getContext('2d');
    if (!context) return 0;
    const data = context.getImageData(0, 0, target.width, target.height).data;
    let green = 0;
    for (let i = 0; i < data.length; i += 16) if (data[i + 1] > 90 && data[i + 1] > data[i] * 1.35 && data[i + 2] < 150) green++;
    return green;
  })).toBeGreaterThan(100);
}

test.describe('Integrated selection and retained-resource evidence @release-soak', () => {
  test.describe.configure({ mode: 'serial' });
  for (const [files, edges] of [[212, 235], [2_000, 8_000], [10_000, 40_000]]) {
    test(`${files} files survive repeated review without resource growth`, async ({ page, browserName }, testInfo) => {
      test.skip(browserName !== 'chromium', 'Heap collection and this local measured sample use Chromium. Core journeys cover three engines.');
      const cycles = Math.max(12, Math.min(5_000, Number(process.env.RELEASE_SOAK_CYCLES) || 24));
      test.setTimeout(Math.max(90_000, cycles * 2_000));
      const graph = files === 212 ? createDemoSnapshot() : createScaleFixture(files, edges, 42);
      const errors: string[] = [], outbound: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { const url = new URL(request.url()); if (!['127.0.0.1', 'localhost'].includes(url.hostname) && /^https?:$/.test(url.protocol)) outbound.push(url.origin); });
      await page.route('**/api/demo', route => route.fulfill({ json: graph }));
      await page.addInitScript(() => {
        const metrics: Probe = { workersCreated: 0, workersTerminated: 0, workersLive: 0, workersPeak: 0, globalListeners: 0, longTasks: [] };
        (window as unknown as MeasuredWindow).__releaseProbe = metrics;
        const NativeWorker = window.Worker;
        if (NativeWorker) {
          window.Worker = class extends NativeWorker {
            private stopped = false;
            constructor(...args: ConstructorParameters<typeof Worker>) {
              super(...args); metrics.workersCreated++; metrics.workersLive++; metrics.workersPeak = Math.max(metrics.workersPeak, metrics.workersLive);
            }
            terminate() { if (!this.stopped) { this.stopped = true; metrics.workersLive--; metrics.workersTerminated++; } super.terminate(); }
          };
        }
        // Track retained handlers on persistent browser globals, not React's delegated
        // element handlers. Duplicate adds of the same listener/capture count once.
        const entries = new WeakMap<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>();
        const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
        const record = (target: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null, options: boolean | AddEventListenerOptions | EventListenerOptions | undefined, delta: number) => {
          if ((target !== window && target !== document) || !callback) return;
          const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
          const key = `${type}:${capture}`; let byType = entries.get(target);
          if (!byType) { byType = new Map(); entries.set(target, byType); }
          let set = byType.get(key); if (!set) { set = new Set(); byType.set(key, set); }
          if (delta > 0 && !set.has(callback)) { set.add(callback); metrics.globalListeners++; }
          else if (delta < 0 && set.delete(callback)) metrics.globalListeners--;
        };
        EventTarget.prototype.addEventListener = function(type, callback, options) { record(this, type, callback, options, 1); return add.call(this, type, callback, options); };
        EventTarget.prototype.removeEventListener = function(type, callback, options) { record(this, type, callback, options, -1); return remove.call(this, type, callback, options); };
        new PerformanceObserver(list => { for (const entry of list.getEntries()) metrics.longTasks.push(entry.duration); }).observe({ type: 'longtask', buffered: false });
      });
      const started = performance.now();
      await page.goto('/'); await paintedFiles(page);
      const coldNavigationToPaintMs = performance.now() - started;
      const warmStarted = performance.now();
      await page.reload(); await paintedFiles(page);
      const warmNavigationToPaintMs = performance.now() - warmStarted;
      const canvas = page.getByTestId('graph-canvas');
      await expect(canvas).toHaveAttribute('aria-label', new RegExp(`${files} files`));
      const camera = await canvas.evaluate(element => ['data-camera-x', 'data-camera-y', 'data-camera-scale'].map(name => element.getAttribute(name)));
      const session = await page.context().newCDPSession(page);
      const retained = async () => {
        await session.send('HeapProfiler.collectGarbage');
        const heap = await session.send('Runtime.getHeapUsage');
        const dom = await session.send('Memory.getDOMCounters');
        return { heapUsedBytes: heap.usedSize as number, heapTotalBytes: heap.totalSize as number, nodes: dom.nodes as number, documents: dom.documents as number, eventListeners: dom.jsEventListeners as number };
      };
      const toggle = graph.sources.filter(source => source.kind === 'pr')[files === 212 ? 2 : 1]!;
      await page.getByTestId('source-selector').click();
      const selectionTimes: number[] = [];
      const clickAndPaint = async () => page.getByTestId(`source-${toggle.id}`).evaluate(async element => {
        const before = document.querySelector('[data-testid="changed-count"]')?.textContent;
        const started = performance.now(); (element as HTMLInputElement).click();
        for (let frame = 0; frame < 120; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          if (document.querySelector('[data-testid="changed-count"]')?.textContent !== before) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            return performance.now() - started;
          }
        }
        throw new Error('Selection feedback did not settle within 120 frames.');
      });
      // Warm the exact review path before comparing retained-resource samples.
      for (let i = 0; i < 4; i++) await clickAndPaint();
      const before = await retained(), beforeProbe = await probe(page);
      const churnStarted = performance.now();
      for (let i = 0; i < cycles; i++) selectionTimes.push(await clickAndPaint());
      const churnDurationMs = performance.now() - churnStarted;
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const after = await retained(), afterProbe = await probe(page);
      expect(await canvas.evaluate(element => ['data-camera-x', 'data-camera-y', 'data-camera-scale'].map(name => element.getAttribute(name)))).toEqual(camera);
      expect(afterProbe.workersCreated).toBe(beforeProbe.workersCreated);
      expect(afterProbe.workersLive).toBe(beforeProbe.workersLive);
      expect(afterProbe.globalListeners).toBeLessThanOrEqual(beforeProbe.globalListeners);
      // Diagnostic tolerances catch major retained growth, not a mathematical proof
      // of leak absence. GC heap and global handler counts are separate evidence.
      expect(after.heapUsedBytes - before.heapUsedBytes).toBeLessThan(Math.max(8_000_000, files * 1_600));
      expect(after.nodes - before.nodes).toBeLessThan(1_000);
      const node = layoutGraph(graph).nodes.find(file => file.id === graph.nodes[0]!.id)!;
      // Files are pointer targets once their lattice is at least 10 px apart on screen; a dense
      // overview hands hover to the island. Zoom in until single files are targetable.
      const pitch = layoutPitch(layoutGraph(graph));
      for (let i = 0; i < 8 && Number(await canvas.getAttribute('data-camera-scale')) * pitch < 10; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      const hoverTimes: number[] = [];
      for (let i = 0; i < 12; i++) {
        await canvas.dispatchEvent('pointerleave', { pointerId: 1, pointerType: 'mouse' });
        hoverTimes.push(await canvas.evaluate(async (element, node) => {
          const target = element as HTMLElement, rect = target.getBoundingClientRect();
          const cameraX = Number(target.dataset.cameraX), cameraY = Number(target.dataset.cameraY), zoom = Number(target.dataset.cameraScale);
          const clientX = rect.left + rect.width / 2 + (node.x - cameraX) * zoom;
          const clientY = rect.top + rect.height / 2 + (node.y - cameraY) * zoom;
          const started = performance.now();
          target.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', clientX, clientY, bubbles: true }));
          for (let frame = 0; frame < 120; frame++) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            if (document.querySelector('[role="tooltip"]')?.textContent?.includes(node.path)) return performance.now() - started;
          }
          throw new Error('Hover evidence tooltip did not render.');
        }, node));
      }
      const report = {
        schemaVersion: '1', measuredAt: new Date().toISOString(), files, edges, seed: 42,
        build: process.env.RELEASE_EVIDENCE_BUILD || 'unspecified', appCommit: process.env.RELEASE_EVIDENCE_COMMIT || 'unspecified',
        conditions: { platform: process.platform, cpu: cpus()[0]?.model, logicalCpus: cpus().length, systemMemoryBytes: totalmem(), node: process.version, browser: await page.evaluate(() => navigator.userAgent), viewport: page.viewportSize(), network: 'loopback; no artificial throttling; synthetic /api/demo response; browser reload cache warm', concurrentActivity: process.env.RELEASE_EVIDENCE_ACTIVITY || 'unspecified: record before interpreting timing as release evidence' },
        coldNavigationToPaintMs, warmNavigationToPaintMs,
        selection: { samples: cycles, durationMs: churnDurationMs, medianMs: percentile(selectionTimes, .5), p95Ms: percentile(selectionTimes, .95), samplesMs: selectionTimes },
        hover: { samples: hoverTimes.length, p95Ms: percentile(hoverTimes, .95), samplesMs: hoverTimes },
        retainedBefore: before, retainedAfter: after, resourcesBefore: beforeProbe, resourcesAfter: afterProbe,
        targets: { selectionP95Ms: 250, hoverP95Ms: 100, cachedPaintMs: 2_000 },
        measuredTargetPass: { selection: percentile(selectionTimes, .95) <= 250, hover: percentile(hoverTimes, .95) < 100, warmNavigation: warmNavigationToPaintMs <= 2_000 },
        limitations: ['Navigation timing includes HTTP/modules/fixture delivery and is not authenticated-response-to-useful-view timing.', 'Synthetic metadata; ingestion, provider latency and cost are not inferred from these values.', 'Bounded churn catches gross retention regressions; run RELEASE_SOAK_CYCLES=1000 on a stable reference runner for a longer session.', 'Pan/frame/layout evidence is supplied by GRAPH-04; backend recovery/correctness is supplied by DATA-09 and DATA-07.'],
      };
      if (process.env.RELEASE_ENFORCE_BUDGETS === '1' && files === 2_000) expect(report.measuredTargetPass).toEqual({ selection: true, hover: true, warmNavigation: true });
      expect(errors).toEqual([]); expect(outbound).toEqual([]);
      const json = JSON.stringify(report, null, 2);
      await testInfo.attach(`release-soak-${files}.json`, { body: json, contentType: 'application/json' });
      const evidenceDirectory = resolve(process.env.RELEASE_EVIDENCE_DIR || '.tmp/release-evidence');
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(resolve(evidenceDirectory, `release-soak-${files}.json`), json + '\n');
      console.log('Integrated churn evidence:', JSON.stringify({ files, cycles, ...report.measuredTargetPass, selectionP95Ms: report.selection.p95Ms, hoverP95Ms: report.hover.p95Ms, heapDeltaBytes: after.heapUsedBytes - before.heapUsedBytes }));
      await session.detach();
    });
  }
});
