import { expect, test } from '@playwright/test';
import { createDemoSnapshot, createScaleFixture } from '../../packages/fixtures/src/index';
import { cpus, platform, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GRAPH_BUDGETS } from '../../packages/graph-core/src/render-policy';

test.describe('Constellation rendering evidence @performance', () => {
  test.describe.configure({ mode: 'serial' });
  for (const [files, edges] of [[212, 235], [2000, 8000], [10000, 40000]]) {
    test(`${files} file circles and ${edges} connections render and pan`, async ({ page, browserName }, testInfo) => {
      test.skip(browserName !== 'chromium', 'The performance sample is recorded on Chromium; correctness journeys cover the other engines.');
      const graph = files === 212 ? createDemoSnapshot() : createScaleFixture(files, edges, 42);
      await page.route('**/api/demo', route => route.fulfill({ json: graph }));
      await page.addInitScript(() => {
        const sample = { dataReadyAt: 0, tasks: [] as { startTime: number; duration: number }[] };
        Object.assign(window, { graphBootSample: sample });
        new PerformanceObserver(list => { for (const entry of list.getEntries()) sample.tasks.push({ startTime: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: false });
        const fetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await fetch(...args);
          if (String(args[0]).endsWith('/api/demo')) {
            const json = response.json.bind(response);
            response.json = async () => { const value = await json(); sample.dataReadyAt = performance.now(); return value; };
          }
          return response;
        };
      });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const navigationStart = performance.now();
      await page.goto('/');
      const canvas = page.getByTestId('graph-canvas');
      await expect(canvas).toBeVisible();
      await expect(canvas).toHaveAttribute('aria-label', new RegExp(`${files} files`));
      // A DOM label and minimap are insufficient proof: the main canvas itself
      // must contain file-circle pixels after React StrictMode remounts effects.
      await expect.poll(() => canvas.evaluate(element => {
        const target = element as HTMLCanvasElement; const context = target.getContext('2d')!;
        const data = context.getImageData(0, 0, target.width, target.height).data;
        let green = 0;
        for (let i = 0; i < data.length; i += 16) if (data[i + 1] > 90 && data[i + 1] > data[i] * 1.35 && data[i + 2] < 150) green++;
        return green;
      })).toBeGreaterThan(100);
      const navigationToRenderedMs = performance.now() - navigationStart;
      await expect(page.getByTestId('graph-surface')).toHaveAttribute('data-layout-state', 'ready');
      const boot = await page.evaluate(() => {
        const sample = (window as unknown as { graphBootSample: { dataReadyAt: number; tasks: { startTime: number; duration: number }[] } }).graphBootSample;
        const heap = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
        return { firstUsefulAfterDataMs: performance.now() - sample.dataReadyAt, startupLongTasks: sample.tasks.filter(task => task.startTime >= sample.dataReadyAt), heap: heap ? { usedBytes: heap.usedJSHeapSize, allocatedBytes: heap.totalJSHeapSize, limitBytes: heap.jsHeapSizeLimit } : null };
      });
      await testInfo.attach(`rendered-${files}`, { body: await page.screenshot({ path: testInfo.outputPath(`rendered-${files}.png`) }), contentType: 'image/png' });
      const initialX = Number(await canvas.getAttribute('data-camera-x'));
      const evidence = await canvas.evaluate(async element => {
        const frames: number[] = [], longTasks: number[] = [];
        const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push(entry.duration); });
        observer.observe({ type: 'longtask', buffered: false });
        const samples = 91; let count = 0, previous = performance.now();
        await new Promise<void>(resolve => {
          const frame = (now: number) => {
            if (count >= 5) frames.push(now - previous);
            previous = now;
            // Alternate directions so the graph stays visible throughout the
            // measurement instead of benchmarking an empty offscreen canvas.
            element.dispatchEvent(new KeyboardEvent('keydown', { key: count % 2 ? 'ArrowLeft' : 'ArrowRight', bubbles: true }));
            count++;
            if (count < samples) requestAnimationFrame(frame); else resolve();
          };
          requestAnimationFrame(frame);
        });
        observer.disconnect(); frames.sort((a, b) => a - b);
        return { viewport: { width: innerWidth, height: innerHeight }, frames: frames.length, frameMedianMs: frames[Math.floor(frames.length / 2)], frameP95Ms: frames[Math.floor(frames.length * .95)], longTasks, browser: navigator.userAgent, devicePixelRatio: devicePixelRatio };
      });
      await expect.poll(async () => Number(await canvas.getAttribute('data-camera-x'))).toBeGreaterThan(initialX);
      expect(errors).toEqual([]);
      const checks = { firstUseful: boot.firstUsefulAfterDataMs <= GRAPH_BUDGETS.firstUsefulMs, pan: evidence.frameP95Ms <= GRAPH_BUDGETS.panP95Ms, startupLongTask: boot.startupLongTasks.every(task => task.duration <= GRAPH_BUDGETS.layoutLongTaskMs) };
      const report = { schemaVersion: '1', files, edges, seed: 42, navigationToRenderedMs, ...boot, ...evidence, conditions: { platform: platform(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), node: process.version, network: 'loopback; synthetic /api/demo response; no GitHub/AI', concurrency: process.env.GRAPH_BENCHMARK_CONCURRENCY || 'unrecorded', cacheState: 'new browser context; first page navigation' }, budgets: GRAPH_BUDGETS, checks, capacity: files > 2000 ? 'stress-only' : 'target', build: process.env.GRAPH_BENCHMARK_BUILD || 'unspecified', note: 'First-use time begins after demo JSON is available and ends at polled green-circle/worker-ready proof; it includes polling overhead. Startup long tasks include app/rendering plus pixel-proof overhead, not isolated worker CPU. JS heap is browser-reported and is not GPU or process memory. Frame samples measure keyboard panning, not ingestion or AI.' };
      Object.assign(report, { seed: files === 212 ? 'authored-constellation-v1' : 42, layoutSeed: 0, commit: process.env.GRAPH_BENCHMARK_COMMIT || 'unrecorded' });
      console.log('Graph rendering evidence:', JSON.stringify(report));
      await testInfo.attach(`graph-performance-${files}.json`, { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
      if (process.env.GRAPH_BENCHMARK_OUTPUT) {
        const output = resolve(process.env.GRAPH_BENCHMARK_OUTPUT);
        await mkdir(output, { recursive: true });
        await writeFile(resolve(output, `fixture-${files}.json`), JSON.stringify(report, null, 2) + '\n');
      }
      if (process.env.GRAPH_ENFORCE_BUDGETS === 'true' && files <= 2000) {
        expect(checks, 'Reference-runner target envelope budgets').toEqual({ firstUseful: true, pan: true, startupLongTask: true });
      }
    });
  }
});
