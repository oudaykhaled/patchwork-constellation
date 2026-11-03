import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('keyboard file exploration reaches every window, exposes overlap/evidence and returns focus', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  const launcher = page.getByTestId('accessible-list-toggle');
  await launcher.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Files in your constellation' });
  await expect(dialog).toBeVisible();
  const rows = dialog.getByTestId('windowed-file-list').getByRole('button');
  await expect(rows).toHaveCount(36);
  await rows.first().focus(); await page.keyboard.press('End');
  await expect(dialog.getByRole('status')).toContainText('181–212 of 212');
  await expect(rows).toHaveCount(32);
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(rows.first()).toBeFocused();
  await dialog.getByLabel('Selection status').selectOption('overlap');
  await expect(dialog.getByRole('status')).toContainText('14 matching files');
  await expect(rows).toHaveCount(14);
  await expect(rows.first()).toContainText('Overlap');
  await expect(rows.first()).toContainText('incoming /');
  await rows.first().focus(); await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('file-inspector')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close file inspector' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(launcher).toBeFocused();
  await expect(page.getByTestId('review-announcement')).toContainText('14 overlapping files');
});

test('automated WCAG 2.2 AA subset covers default, source selection, explorer and inspector', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  const scan = async (name: string) => {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    await testInfo.attach(`axe-${name}`, { body: JSON.stringify({ browser: testInfo.project.name, testedUrl: '/', violations: result.violations, passes: result.passes.map(pass => pass.id), incomplete: result.incomplete.map(item => item.id) }, null, 2), contentType: 'application/json' });
    expect(result.violations, JSON.stringify(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })))).toEqual([]);
  };
  await scan('graph');
  await page.getByTestId('source-selector').click(); await scan('sources'); await page.keyboard.press('Escape');
  await page.getByTestId('accessible-list-toggle').click(); await scan('explorer');
  await page.getByLabel('Filter file list').fill('refresh.ts');
  await page.getByTestId('windowed-file-list').getByRole('button').first().click();
  await scan('inspector');
});

test('narrow reduced-motion and forced-colors explorer keeps all core facts and controls', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  const narrowScan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(narrowScan.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
  await page.getByTestId('accessible-list-toggle').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Island', { exact: true }).selectOption({ index: 1 });
  await expect(dialog.getByRole('button', { name: 'Focus selected island' })).toBeVisible();
  await dialog.getByLabel('Selection status').selectOption('changed');
  await expect(dialog.getByTestId('windowed-file-list').getByRole('button').first()).toContainText('source');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('accessible-list-toggle')).toBeFocused();
});
