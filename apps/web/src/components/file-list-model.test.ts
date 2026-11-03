import { describe, expect, it } from 'vitest';
import { demoSnapshot, createScaleFixture } from '@patchwork/fixtures';
import { FILE_LIST_WINDOW, fileListRows, fileListWindow } from './file-list-model';

describe('accessible file explorer model', () => {
  it('keeps exact selection overlap, observed kind and directed imports distinct', () => {
    const selected = demoSnapshot.sources.filter(source => source.kind === 'pr').slice(0, 3).map(source => source.id);
    const rows = fileListRows(demoSnapshot, selected);
    expect(rows).toHaveLength(212);
    expect(rows.filter(row => row.sourceCount > 0)).toHaveLength(68);
    expect(rows.filter(row => row.sourceCount > 1)).toHaveLength(14);
    expect(rows.reduce((total, row) => total + row.incoming, 0)).toBe(235);
    expect(rows.reduce((total, row) => total + row.outgoing, 0)).toBe(235);
    expect(rows.filter(row => row.sourceCount === 0).every(row => row.statuses[0] === 'unchanged context')).toBe(true);
    expect(fileListRows(demoSnapshot, []).every(row => row.sourceCount === 0)).toBe(true);
  });

  it('allows all large-snapshot files through bounded windows without a silent 300-file cap', () => {
    const rows = fileListRows(createScaleFixture(10_000, 40_000, 42), []);
    const seen = new Set<string>();
    for (let page = 0; page < Math.ceil(rows.length / FILE_LIST_WINDOW); page++) {
      const range = fileListWindow(rows.length, page);
      const entries = rows.slice(range.start, range.end);
      expect(entries.length).toBeLessThanOrEqual(FILE_LIST_WINDOW);
      for (const row of entries) seen.add(row.id);
    }
    expect(seen.size).toBe(10_000);
    expect(fileListWindow(0, 100)).toEqual({ page: 0, pages: 1, start: 0, end: 0 });
    expect(fileListWindow(212, 100)).toEqual({ page: 5, pages: 6, start: 180, end: 212 });
  });
});
