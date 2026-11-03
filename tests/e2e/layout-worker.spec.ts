import { expect, test } from '@playwright/test';
import { createDemoSnapshot } from '../../packages/fixtures/src/index';

test('layout worker settles once; changing PR highlights retains worker count and camera', async ({ page }) => {
  await page.route('**/api/demo', route => route.fulfill({ json: createDemoSnapshot() }));
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    Object.assign(window, { layoutWorkersStarted: 0 });
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name === 'constellation-layout') (window as unknown as { layoutWorkersStarted: number }).layoutWorkersStarted++;
      }
    };
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Reset island layout' })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Explore Authentication/ })).toBeVisible();
  const before = await page.evaluate(() => (window as unknown as { layoutWorkersStarted: number }).layoutWorkersStarted);
  const canvas = page.getByTestId('graph-canvas');
  const camera = await canvas.evaluate(element => [element.getAttribute('data-camera-x'), element.getAttribute('data-camera-y'), element.getAttribute('data-camera-scale')]);
  await page.getByTestId('source-selector').click();
  await page.getByTestId('source-pr-256').click();
  await expect(page.getByTestId('changed-count')).toHaveText('57');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as unknown as { layoutWorkersStarted: number }).layoutWorkersStarted)).toBe(before);
  expect(await canvas.evaluate(element => [element.getAttribute('data-camera-x'), element.getAttribute('data-camera-y'), element.getAttribute('data-camera-scale')])).toEqual(camera);
  await page.getByRole('button', { name: 'Reset island layout' }).click();
  await expect(page.getByRole('button', { name: 'Reset island layout' })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { layoutWorkersStarted: number }).layoutWorkersStarted)).toBe(before + 1);
});

test('worker construction failure preserves selection and accessible list plus retry', async ({ page }) => {
  await page.route('**/api/demo', route => route.fulfill({ json: createDemoSnapshot() }));
  await page.addInitScript(() => { window.Worker = class { constructor() { throw new Error('Worker blocked'); } } as unknown as typeof Worker; });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Retry layout' })).toBeVisible();
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await page.getByTestId('accessible-list-toggle').click();
  await page.getByLabel('Filter file list').fill('refresh.ts');
  await page.getByRole('button', { name: /refresh\.ts/ }).first().click();
  await expect(page.getByTestId('file-inspector')).toContainText('refresh.ts');
});
