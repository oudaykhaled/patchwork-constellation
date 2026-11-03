import { expect, test, type Page } from '@playwright/test';
import { createScaleFixture } from '../../packages/fixtures/src/index';

async function visibleCircles(page: Page) {
  const canvas = page.getByTestId('graph-canvas');
  await expect(page.getByTestId('graph-surface')).toHaveAttribute('data-layout-state', 'ready');
  await expect.poll(() => canvas.evaluate(element => {
    const target = element as HTMLCanvasElement, context = target.getContext('2d');
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, target.width, target.height).data;
    let green = 0;
    for (let i = 0; i < pixels.length; i += 16) if (pixels[i + 1] > 90 && pixels[i + 1] > pixels[i] * 1.35 && pixels[i + 2] < 150) green++;
    return green;
  })).toBeGreaterThan(100);
}
async function camera(page: Page) {
  return page.getByTestId('graph-canvas').evaluate(element => [element.getAttribute('data-camera-x'), element.getAttribute('data-camera-y'), element.getAttribute('data-camera-scale')].map(value => Number(Number(value).toFixed(5))));
}
async function sharedCamera(page: Page) {
  return page.evaluate(() => new URLSearchParams(location.search).get('camera')?.split(',').map(Number));
}

test('a large graph shares only its settled camera and reload retains visible file pixels', async ({ page }) => {
  const graph = createScaleFixture(10_000, 40_000, 42);
  // Arrive after the 200 ms write window begins. A bootstrap fit followed by a
  // fast real-worker fit previously left only the bootstrap camera in the URL.
  await page.route('**/api/demo', async route => { await new Promise(resolve => setTimeout(resolve, 250)); await route.fulfill({ json: graph }); });
  await page.goto('/'); await visibleCircles(page);
  const settled = await camera(page);
  await expect.poll(() => sharedCamera(page)).toEqual(settled);
  await page.reload(); await visibleCircles(page);
  expect(await camera(page)).toEqual(settled);
  await expect.poll(() => sharedCamera(page)).toEqual(settled);
});

test('the final rapid pan is flushed without restoring a superseded source selection', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/'); await visibleCircles(page);
  const canvas = page.getByTestId('graph-canvas');
  // These updates all occur inside the URL write interval; the final one must
  // survive, including a source selection made before the trailing flush.
  await canvas.evaluate(element => {
    for (let i = 0; i < 5; i++) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  const final = await camera(page);
  await page.getByRole('button', { name: 'Remove #256', exact: true }).click();
  await expect(page.getByTestId('changed-count')).toHaveText('57');
  await expect.poll(() => sharedCamera(page)).toEqual(final);
  await expect.poll(() => page.evaluate(() => new URLSearchParams(location.search).get('sources'))).toBe('pr-248,pr-251');
  await page.reload(); await visibleCircles(page);
  expect(await camera(page)).toEqual(final);
  await expect(page.getByTestId('changed-count')).toHaveText('57');
});
