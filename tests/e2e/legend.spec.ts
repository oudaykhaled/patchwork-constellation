import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`graph meaning stays available and dismissible at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const explanation = page.getByRole('region', { name: 'Graph symbols and connections' });
    const toggle = page.locator('summary[aria-label="Explain graph symbols and connections"]');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(explanation).toBeVisible();
    await expect(explanation).toContainText('Select a file to inspect direction, relation and evidence.');
    await expect(explanation).toContainText('Overlap does not prove a merge conflict.');
    const box = await explanation.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    // Floating map controls must not paint over the open explanation.
    expect(await explanation.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const topElement = document.elementFromPoint(rect.x + 30, rect.y + 30);
      return Boolean(topElement && element.contains(topElement));
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('legend-open.png') });
    await page.keyboard.press('Escape');
    await expect(explanation).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(page.getByTestId('graph-viewport')).toBeVisible();
  });
}
