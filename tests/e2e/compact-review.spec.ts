import { expect, test, type Locator } from '@playwright/test';

async function expectReachable(control: Locator) {
  await expect(control).toBeVisible();
  expect(await control.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const centerX = rect.x + rect.width / 2, centerY = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    return rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && !!hit && (element === hit || element.contains(hit));
  })).toBe(true);
}

// Compact CSS viewports protect reflow after browser zoom. They deliberately do
// not claim to operate the native browser zoom setting or replace that review.
for (const viewport of [{ width: 640, height: 360 }, { width: 800, height: 450 }]) {
  test(`core review actions remain reachable at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByTestId('changed-count')).toHaveText('68');
    const sourcePicker = page.getByTestId('source-selector');
    await expectReachable(sourcePicker);
    await sourcePicker.click();
    await page.getByTestId('source-pr-256').uncheck();
    await expect(page.getByTestId('changed-count')).toHaveText('57');
    await page.getByRole('button', { name: 'Explore changes' }).click();
    await expect(sourcePicker).toBeFocused();

    const search = page.getByTestId('file-search');
    await expectReachable(search);
    await search.fill('refresh.ts');
    await page.getByRole('option', { name: /refresh\.ts/ }).click();
    await expect(page.getByTestId('file-inspector')).toContainText('refresh.ts');
    const close = page.getByRole('button', { name: 'Close file inspector' });
    await expectReachable(close);
    await close.click();

    const files = page.getByTestId('accessible-list-toggle');
    await expectReachable(files);
    await files.click();
    await page.getByLabel('Filter file list').fill('refresh.ts');
    const result = page.getByRole('dialog').getByRole('button', { name: /refresh\.ts/ }).first();
    await result.click();
    await expect(page.getByTestId('file-inspector')).toContainText('refresh.ts');
    await page.getByRole('button', { name: 'Close file inspector' }).click();

    const legend = page.locator('summary[aria-label="Explain graph symbols and connections"]');
    await expectReachable(legend);
    await legend.click();
    const explanation = page.getByRole('region', { name: 'Graph symbols and connections' });
    await expect(explanation).toBeVisible();
    const bounds = await explanation.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await page.keyboard.press('Escape');
    await expect(legend).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await testInfo.attach('compact-review', { body: await page.screenshot(), contentType: 'image/png' });
  });
}
