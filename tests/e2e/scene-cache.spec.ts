import { expect, test } from '@playwright/test';
import { createScaleFixture } from '../../packages/fixtures/src/index';

test('pan reuses all 8,000 cached connections and translates file pixels without a scene rebuild', async ({ page }) => {
  await page.route('**/api/demo', route => route.fulfill({ json: createScaleFixture(2_000, 8_000, 42) }));
  await page.addInitScript(() => {
    Object.assign(window, { graphCurveOperations: 0, graphCircleOperations: 0 });
    const curve = CanvasRenderingContext2D.prototype.quadraticCurveTo;
    CanvasRenderingContext2D.prototype.quadraticCurveTo = function(...args) {
      (window as unknown as { graphCurveOperations: number }).graphCurveOperations++;
      return curve.apply(this, args);
    };
    const circle = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function(...args) {
      (window as unknown as { graphCircleOperations: number }).graphCircleOperations++;
      return circle.apply(this, args);
    };
  });
  await page.goto('/');
  const canvas = page.getByTestId('graph-canvas');
  await expect(page.getByTestId('graph-surface')).toHaveAttribute('data-layout-state', 'ready');
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  await expect.poll(async () => Number(await canvas.getAttribute('data-scene-cache-builds'))).toBeGreaterThan(0);
  const before = await canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement, context = canvas.getContext('2d')!;
    Object.assign(window, { graphBeforePixels: context.getImageData(0, 0, canvas.width, canvas.height) });
    return { builds: Number(canvas.dataset.sceneCacheBuilds), hits: Number(canvas.dataset.sceneCacheHits), curves: (window as unknown as { graphCurveOperations: number }).graphCurveOperations, circles: (window as unknown as { graphCircleOperations: number }).graphCircleOperations, x: Number(canvas.dataset.cameraX) };
  });
  expect(before.curves).toBeGreaterThanOrEqual(8_000);
  expect(before.circles).toBeGreaterThanOrEqual(2_000);
  await canvas.press('ArrowRight');
  await expect.poll(async () => Number(await canvas.getAttribute('data-scene-cache-hits'))).toBeGreaterThan(before.hits);
  const after = await canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement, context = canvas.getContext('2d')!;
    const old = (window as unknown as { graphBeforePixels: ImageData }).graphBeforePixels, next = context.getImageData(0, 0, canvas.width, canvas.height);
    let samples = 0, mismatched = 0;
    // A right pan moves every cached file pixel sixty CSS pixels left. Inspect
    // colored file pixels, not only counters or the moving background grid.
    const shift = Math.round(60 * Math.min(devicePixelRatio, 2));
    for (let y = 100; y < next.height - 100; y++) for (let x = 100; x < next.width - shift - 100; x++) {
      const previous = (y * old.width + x + shift) * 4, current = (y * next.width + x) * 4;
      if (old.data[previous + 1] > 90 && old.data[previous + 1] > old.data[previous] * 1.35 && old.data[previous + 2] < 150) {
        samples++;
        if (Math.max(...[0, 1, 2].map(channel => Math.abs(old.data[previous + channel] - next.data[current + channel]))) > 8) mismatched++;
      }
    }
    return { builds: Number(canvas.dataset.sceneCacheBuilds), curves: (window as unknown as { graphCurveOperations: number }).graphCurveOperations, circles: (window as unknown as { graphCircleOperations: number }).graphCircleOperations, samples, mismatch: mismatched / Math.max(1, samples), bytes: Number(canvas.dataset.sceneCacheBytes), x: Number(canvas.dataset.cameraX) };
  });
  expect(after.x).toBeGreaterThan(before.x);
  expect(after.builds).toBe(before.builds);
  expect(after.curves).toBe(before.curves);
  expect(after.circles).toBe(before.circles);
  expect(after.samples).toBeGreaterThan(100);
  expect(after.mismatch).toBeLessThan(.02);
  expect(after.bytes).toBeLessThanOrEqual(64_000_000);
  await page.getByRole('combobox', { name: 'Find a file, folder or island' }).fill('file-000001');
  await expect.poll(async () => Number(await canvas.getAttribute('data-scene-cache-builds'))).toBeGreaterThan(after.builds);
  const searchBuilds = Number(await canvas.getAttribute('data-scene-cache-builds'));
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => Number(await canvas.getAttribute('data-scene-cache-builds'))).toBeGreaterThan(searchBuilds);
  await canvas.dispatchEvent('contextlost', { cancelable: true });
  await expect(page.getByRole('button', { name: 'Retry graph', exact: true })).toBeVisible();
  await canvas.dispatchEvent('contextrestored');
  await expect(page.getByRole('button', { name: 'Retry graph', exact: true })).not.toBeVisible();
  await expect.poll(async () => Number(await canvas.getAttribute('data-scene-cache-builds'))).toBeGreaterThan(searchBuilds + 1);
});
