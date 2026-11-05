import { describe, expect, it } from 'vitest';
import { islandTipMeta } from './island-tip';

describe('island tooltip second line', () => {
  it('does not repeat the island name and says how the island was grouped', () => {
    expect(islandTipMeta({ label: 'Editor', path: 'src/editor', origin: 'rules' })).toBe('in src/ · Grouped by folder rule');
    expect(islandTipMeta({ label: 'Editor part-1', path: 'src/editor/part-1', origin: 'rules' })).toBe('in src/ · Grouped by folder rule');
    expect(islandTipMeta({ label: 'Docs', path: 'docs', origin: 'rules' })).toBe('Grouped by folder rule');
    expect(islandTipMeta({ label: 'Repository root', path: '', origin: 'rules' })).toBe('Grouped by folder rule');
  });
  it('keeps a path that says something the name does not', () => {
    expect(islandTipMeta({ label: 'Notes app', path: 'apps/web', origin: 'manifest' })).toBe('apps/web · Package manifest');
    expect(islandTipMeta({ label: 'Billing', origin: 'manual' })).toBe('Your grouping');
    expect(islandTipMeta({ label: 'Search', path: 'src/search', origin: 'ai' })).toBe('in src/ · AI grouping');
    expect(islandTipMeta({ label: 'Search', path: 7, origin: 'unknown' })).toBe('');
  });
});
