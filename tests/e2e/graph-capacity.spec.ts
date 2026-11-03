import { expect, test } from '@playwright/test';
import { createDemoSnapshot, createScaleFixture } from '../../packages/fixtures/src/index';

test('stress graph offers explicit island scope without changing selection or complete counts', async ({ page }) => {
  const graph = createScaleFixture(10_000, 40_000, 42);
  const group = graph.groups[0];
  const files = graph.nodes.filter(node => node.groupId === group.id).length;
  await page.route('**/api/demo', route => route.fulfill({ json: graph }));
  await page.goto('/');
  await expect(page.getByTestId('graph-surface')).toHaveAttribute('data-layout-state', 'ready');
  const before = await page.getByTestId('changed-count').textContent();
  await expect(page.getByText('Above the 2,000-file / 8,000-connection target.', { exact: false })).toBeVisible();
  await page.getByLabel('Explore scope', { exact: true }).selectOption(group.id);
  await expect(page.getByText(new RegExp(`Showing ${files.toLocaleString()} of 10,000 files`))).toBeVisible();
  await expect(page.locator('.island-label')).toHaveCount(1);
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('aria-label', /10000 files/);
  await expect(page.getByTestId('changed-count')).toHaveText(before!);
  await page.getByLabel('Explore scope', { exact: true }).selectOption('');
  await expect(page.getByText('Showing 10,000 of 10,000 files · 40,000 of 40,000 connections')).toBeVisible();
  await expect(page.locator('.island-label')).toHaveCount(12);
});

test('worker failure and context loss expose list and retry without discarding source choices', async ({ page }) => {
  await page.route('**/api/demo', route => route.fulfill({ json: createDemoSnapshot() }));
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    let fail = true;
    Object.assign(window, { recoverLayoutWorker: () => { fail = false; } });
    window.Worker = class extends OriginalWorker { constructor(url: string | URL, options?: WorkerOptions) { if (fail && options?.name === 'constellation-layout') throw new Error('Injected worker outage'); super(url, options); } };
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Retry layout' })).toBeVisible();
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await expect(page.locator('.graph-canvas-error').getByRole('button', { name: 'Open file list' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { recoverLayoutWorker: () => void }).recoverLayoutWorker());
  await page.getByRole('button', { name: 'Retry layout' }).click();
  await expect(page.getByTestId('graph-surface')).toHaveAttribute('data-layout-state', 'ready');
  const canvas = page.getByTestId('graph-canvas');
  await canvas.dispatchEvent('contextlost', { bubbles: false, cancelable: true });
  await expect(page.getByRole('button', { name: 'Retry graph' })).toBeVisible();
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await canvas.dispatchEvent('contextrestored');
  await expect(page.getByText('Graph rendering is unavailable')).not.toBeVisible();
  await expect(page.getByTestId('changed-count')).toHaveText('68');
});
