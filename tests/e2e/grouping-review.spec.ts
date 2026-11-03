import { expect, test, type Page } from '@playwright/test';
import { createDemoSnapshot } from '../../packages/fixtures/src/index';

const initial = createDemoSnapshot();
const membership = Object.fromEntries(initial.nodes.map(node => [node.id, node.groupId]));
const revision = { id: 'accepted-initial', snapshotId: initial.id, parentRevisionId: null, origin: 'rules', schemaVersion: '1', status: 'accepted', provenance: { source: 'canonical', snapshotId: initial.id, contextSha: initial.contextSha } };
async function fixture(page: Page, proposal: object) {
  await page.route('**/api/demo', route => route.fulfill({ json: structuredClone(initial) }));
  await page.route('**/api/grouping/current?*', route => route.fulfill({ json: { snapshot: structuredClone(initial), revision, canUndo: false } }));
  await page.route('**/api/grouping', route => route.fulfill({ json: proposal }));
  await page.goto('/');
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await page.getByTestId('grouping-controls').click();
  await expect(page.getByRole('dialog')).toContainText('accepted-initial');
  await expect(page.getByRole('button', { name: 'Review with AI + Jev', exact: true })).toBeEnabled();
}

test('proposal shows readable evidence, uncertainty and movement before applying', async ({ page }) => {
  const file = initial.nodes[0]!; const target = initial.groups.find(group => group.id !== file.groupId)!;
  const proposal = { id: 'review-movement', status: 'proposed', origin: 'ai-jev', parentRevisionId: revision.id, groups: initial.groups, membership: { ...membership, [file.id]: target.id }, decisions: [{ fileId: file.id, groupId: target.id, rationale: 'Observed imports connect this file to the target module.', evidenceIds: [`file:${file.id}`, initial.edges[0]!.id], confidence: .83 }], models: { jev: 'jev-evaluated-fixture', generative: 'names-fixture' }, dataPolicy: { analyzedFiles: 1, excludedFiles: 3, fieldsSent: ['paths'] } };
  await fixture(page, proposal);
  await page.getByRole('button', { name: 'Review with AI + Jev', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('AI-GENERATED PROPOSAL');
  await expect(dialog).toContainText('Evidence coverage: 1 of 212');
  await dialog.locator('.proposal-islands > details').filter({ hasText: target.label }).locator('summary').first().click();
  await expect(dialog).toContainText('83% confidence');
  await expect(dialog).toContainText('not measured accuracy');
  await expect(dialog.getByRole('img', { name: /1 file movements/ })).toBeVisible();
  await dialog.getByText('Review every changed membership (1)', { exact: true }).click();
  await expect(dialog.locator('.membership-changes')).toContainText(file.path);
  await expect(dialog.locator('.membership-changes')).toContainText(target.label);
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await expect(dialog.getByRole('button', { name: 'Apply reviewed grouping' })).toBeEnabled();
});

test('foreign proposal evidence disables apply and retains the graph', async ({ page }) => {
  await fixture(page, { id: 'invalid', status: 'proposed', groups: initial.groups, membership, decisions: [{ fileId: initial.nodes[0]!.id, groupId: initial.nodes[0]!.groupId, evidenceIds: ['foreign:private-file'], confidence: .95 }] });
  await page.getByRole('button', { name: 'Review with AI + Jev', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('unknown reference');
  await expect(page.getByRole('button', { name: 'Apply reviewed grouping' })).toBeDisabled();
  await expect(page.getByTestId('changed-count')).toHaveText('68');
});

test('provider budget failure retains baseline with readable recovery', async ({ page }) => {
  await fixture(page, { id: 'baseline', status: 'baseline', origin: 'rules', message: 'Provider request budget exhausted. Current grouping retained.', dataPolicy: { analyzedFiles: 0, excludedFiles: 3, fieldsSent: [] } });
  await page.getByRole('button', { name: 'Review with AI + Jev', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('BASELINE PRESERVED');
  await expect(page.getByRole('dialog')).toContainText('budget exhausted');
  await expect(page.getByRole('button', { name: 'Apply reviewed grouping' })).toHaveCount(0);
  await expect(page.getByTestId('changed-count')).toHaveText('68');
});

test('configured providers with a blocked evaluation show the gate reason', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: { ai: { configured: true, available: false, evaluation: { passed: false, reason: 'Human-reviewed holdout evaluation is pending. AI stays disabled.' } } } }));
  await fixture(page, { status: 'baseline', message: 'Evaluation pending.' });
  await expect(page.getByRole('dialog')).toContainText('Human-reviewed holdout evaluation is pending.');
  await expect(page.getByRole('dialog')).not.toContainText('Server credentials required for live AI');
});

test('structurally invalid model output keeps the complete current grouping', async ({ page }) => {
  await fixture(page, { status: 'proposed', groups: { unexpected: 'object' }, message: { unsafe: 'shape' } });
  await page.getByRole('button', { name: 'Review with AI + Jev', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('The grouping response was invalid.');
  await expect(page.getByRole('dialog').locator('.grouping-list strong')).toHaveCount(6);
  await expect(page.getByTestId('changed-count')).toHaveText('68');
});

test('manual revision conflicts preserve the active map until explicit review', async ({ page }) => {
  await fixture(page, { status: 'baseline' });
  let expectedRevision = '';
  await page.route('**/api/grouping/mutate', route => { expectedRevision = route.request().postDataJSON().expectedRevisionId; return route.fulfill({ status: 409, json: { error: 'Grouping changed. Review the latest revision before editing.', code: 'REVISION_CONFLICT' } }); });
  const dialog = page.getByRole('dialog');
  const name = await dialog.locator('.grouping-list strong').first().innerText();
  await dialog.getByRole('button', { name: 'Rename', exact: true }).first().click();
  await dialog.getByLabel('Island name', { exact: true }).fill('Concurrent replacement');
  await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Review the latest revision');
  expect(expectedRevision).toBe(revision.id);
  await expect(dialog.locator('.grouping-list strong').first()).toHaveText(name);
  await dialog.getByRole('button', { name: 'Review latest revision', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('why-this-group works from a file and from a focused island', async ({ page }) => {
  await page.route('**/api/grouping/current?*', route => route.fulfill({ json: { snapshot: structuredClone(initial), revision, canUndo: false } }));
  await page.goto('/');
  await expect(page.getByTestId('changed-count')).toHaveText('68');
  await page.getByTestId('file-search').fill('refresh.ts');
  await page.getByRole('option', { name: /refresh\.ts/ }).first().click();
  await page.getByTestId('file-inspector').getByRole('button', { name: 'Why this group?', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('region', { name: 'Why this group?' })).toContainText('observed file paths');
  await page.keyboard.press('Escape');
  await page.getByTestId('file-inspector').getByRole('button', { name: 'Close file inspector' }).click();
  await page.getByRole('button', { name: /Explore .* island, .* changed/ }).first().click();
  await page.locator('.focus-breadcrumb').getByRole('button', { name: 'Why this group?', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('region', { name: 'Why this group?' })).toContainText('deterministic grouping rules');
});

test('generated text stays escaped and rejection preserves the accepted revision', async ({ page }) => {
  const groups = initial.groups.map((group, index) => index === 0 ? { ...group, label: '<img src=x onerror="window.injectionRan=true">' } : group);
  await fixture(page, { id: 'escaped', status: 'proposed', groups, membership, message: '<script>window.injectionRan=true</script>' });
  let rejected = false;
  await page.route('**/api/grouping/reject', route => { rejected = true; return route.fulfill({ json: { rejected: true } }); });
  await page.getByRole('button', { name: 'Review with AI + Jev', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('<script>window.injectionRan=true</script>');
  expect(await page.evaluate(() => 'injectionRan' in window)).toBe(false);
  await page.getByRole('button', { name: 'Reject proposal', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Grouping proposal' })).toHaveCount(0);
  expect(rejected).toBe(true);
  await expect(page.getByRole('dialog')).toContainText('accepted-initial');
});
