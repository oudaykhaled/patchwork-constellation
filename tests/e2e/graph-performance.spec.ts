import { expect, test } from '@playwright/test';
import { createDemoSnapshot, createScaleFixture } from '../../packages/fixtures/src/index';

test.describe('Constellation rendering evidence @performance', () => {
  test.describe.configure({ mode: 'serial' });
  for (const [files, edges] of [[212, 235], [2000, 8000], [10000, 40000]]) {
    test(`${files} file circles and ${edges} connections render and pan`, async ({ page, browserName }, testInfo) => {
      test.skip(browserName !== 'chromium', 'The performance sample is recorded on Chromium; correctness journeys cover the other engines.');
      const graph = files === 212 ? createDemoSnapshot() : createScaleFixture(files, edges, 42);
      await page.route('**/api/demo', route => route.fulfill({ json: graph }));
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
        return { frames: frames.length, frameMedianMs: frames[Math.floor(frames.length / 2)], frameP95Ms: frames[Math.floor(frames.length * .95)], longTasks, browser: navigator.userAgent, devicePixelRatio: devicePixelRatio };
      });
      await expect.poll(async () => Number(await canvas.getAttribute('data-camera-x'))).toBeGreaterThan(initialX);
      expect(errors).toEqual([]);
      const report = { files, edges, seed: 42, viewport: { width: 1600, height: 1000 }, navigationToRenderedMs, ...evidence, note: 'Local development build. Navigation time includes network and module loading. Frame samples measure keyboard panning, not ingestion or AI. Scale data are injected only by this test.' };
      console.log('Graph rendering evidence:', JSON.stringify(report));
      await testInfo.attach(`graph-performance-${files}.json`, { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    });
  }
});
