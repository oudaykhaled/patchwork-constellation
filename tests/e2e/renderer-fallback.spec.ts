import { expect, test } from '@playwright/test';

test('renderer failure preserves source selection, file inspection and retry', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    let fail = true;
    Object.defineProperty(window, 'restoreCanvasForTest', { value: () => { fail = false; } });
    (HTMLCanvasElement.prototype as any).getContext = function(type: string, ...options: unknown[]) {
      if (type === '2d' && this.classList.contains('constellation-canvas') && fail) return null;
      return original.call(this, type as any, ...options as []);
    };
  });
  await page.goto('/');
  await expect(page.getByText('Graph rendering is unavailable')).toBeVisible();
  await expect(page.getByText('68 affected files, 14 overlapping files.', { exact: true })).toBeVisible();
  await page.locator('.graph-canvas-error').getByRole('button', { name: 'Open file list', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Files in your constellation' })).toBeVisible();
  await expect(page.locator('.accessible-file-list > button')).toHaveCount(212);
  await page.locator('.accessible-file-list > button').first().click();
  await expect(page.getByTestId('file-inspector')).toBeVisible();
  await page.getByRole('button', { name: 'Close file inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Retry graph', exact: true }).click();
  await expect(page.getByText('Graph rendering is unavailable')).toBeVisible();
  await page.evaluate(() => (window as any).restoreCanvasForTest());
  await page.getByRole('button', { name: 'Retry graph', exact: true }).click();
  await expect(page.getByText('Graph rendering is unavailable')).not.toBeVisible();
  await expect.poll(() => page.getByTestId('graph-canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement, context = canvas.getContext('2d')!;
    return canvas.width > 0 && context.getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 !== 3 && value > 50);
  })).toBe(true);
});
