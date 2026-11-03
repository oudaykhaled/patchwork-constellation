import { expect, test } from '@playwright/test';
import { demoSnapshot } from '../../packages/fixtures/src/index';

const old = { ...structuredClone(demoSnapshot), id: 'refresh-old-context', mode: 'github' as const, contextSha: 'a'.repeat(40), createdAt: '2020-01-01T00:00:00.000Z' };
const next = { ...structuredClone(old), id: 'refresh-new-context', contextSha: 'b'.repeat(40), createdAt: '2031-01-01T00:00:00.000Z' };
test('webhook refresh is explicit and preserves a surviving file focus and selected sources', async ({ page }) => {
  await page.route('**/api/demo', route => route.fulfill({ json: old }));
  await page.route('**/api/sources', route => route.fulfill({ json: route.request().postDataJSON().snapshotId === next.id ? next : old }));
  await page.route('**/api/refresh?**', route => route.fulfill({ json: { available: true, state: { revision: 1, stale: true, revoked: false, updatedAt: '2030-01-01T00:00:00.000Z', jobId: 'new-analysis' } } }));
  await page.route('**/api/jobs/new-analysis?**', route => route.fulfill({ json: { status: 'ready', snapshot: next } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Apply refresh' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`context=${old.contextSha}`));
  await page.getByTestId('file-search').fill('refresh.ts'); await page.getByTestId('file-search').press('Enter');
  await expect(page.getByTestId('file-inspector')).toContainText('refresh.ts');
  const selected = new URL(page.url()).searchParams.get('sources');
  await page.getByRole('button', { name: 'Apply refresh' }).click();
  await expect(page).toHaveURL(new RegExp(`context=${next.contextSha}`));
  await expect(page.getByTestId('file-inspector')).toContainText('refresh.ts');
  expect(new URL(page.url()).searchParams.get('sources')).toBe(selected);
  await expect(page.getByRole('button', { name: 'Apply refresh' })).toBeHidden();
});

test('revoked access offers explicit reconciliation and does not install data automatically', async ({ page }) => {
  await page.route('**/api/demo', route => route.fulfill({ json: old }));
  await page.route('**/api/sources', route => route.fulfill({ json: old }));
  await page.route('**/api/refresh?**', route => route.fulfill({ json: { available: true, state: { revision: 1, stale: true, revoked: true, updatedAt: '2030-01-01T00:00:00.000Z' } } }));
  await page.route('**/api/refresh/reconcile', route => route.fulfill({ status: 403, json: { error: 'Reconnect GitHub to verify repository access.' } }));
  await page.goto('/'); await expect(page.getByText('Repository access changed. Reconnect to verify access.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply refresh' })).toBeHidden();
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByText('Reconnect GitHub to verify repository access.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`context=${old.contextSha}`));
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
});
