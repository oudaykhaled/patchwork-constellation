import { describe, expect, it } from 'vitest';
import { validateGraphSnapshot } from '@patchwork/contracts';
import { createDemoSnapshot, createScaleFixture, DEMO_COMMIT_SOURCE_IDS, DEMO_DEFAULT_SOURCE_IDS } from './index';

function footprint(ids: readonly string[]) {
  const snapshot = createDemoSnapshot();
  const membership = new Map<string, number>();
  for (const source of snapshot.sources.filter((source) => ids.includes(source.id))) {
    for (const file of source.files) membership.set(file.fileId, (membership.get(file.fileId) ?? 0) + 1);
  }
  const affected = snapshot.nodes.filter((node) => membership.has(node.id));
  return {
    unique: membership.size,
    overlap: [...membership.values()].filter((count) => count > 1).length,
    groups: new Set(affected.map((node) => node.groupId)).size,
    byGroup: snapshot.groups.map((group) => ({
      changed: affected.filter((node) => node.groupId === group.id).length,
      overlap: affected.filter((node) => node.groupId === group.id && membership.get(node.id)! > 1).length,
    })),
  };
}

describe('authored Constellation fixture', () => {
  it('provides 212 distinct files, six islands and 235 evidenced imports', () => {
    const snapshot = validateGraphSnapshot(createDemoSnapshot());
    expect(snapshot.nodes).toHaveLength(212);
    expect(snapshot.groups).toHaveLength(6);
    expect(snapshot.edges).toHaveLength(235);
    expect(new Set(snapshot.nodes.map((node) => node.path)).size).toBe(212);
    expect(new Set(snapshot.edges.map((edge) => `${edge.source}:${edge.target}`)).size).toBe(235);
    expect(snapshot.groups.map((group) => snapshot.nodes.filter((node) => node.groupId === group.id).length)).toEqual([42, 36, 40, 46, 28, 20]);
    expect(snapshot.nodes[0]?.path).toBe('src/auth/session/refresh.ts');
    expect(snapshot.edges.every((edge) => edge.evidence)).toBe(true);
  });

  it('matches the independently authored three-PR union and overlap', () => {
    expect(createDemoSnapshot().sources.filter((source) => DEMO_DEFAULT_SOURCE_IDS.includes(source.id as typeof DEMO_DEFAULT_SOURCE_IDS[number])).map((source) => source.files.length)).toEqual([28, 31, 25]);
    expect(footprint(DEMO_DEFAULT_SOURCE_IDS)).toEqual({ unique: 68, overlap: 14, groups: 6, byGroup: [
      { changed: 18, overlap: 4 }, { changed: 14, overlap: 4 }, { changed: 12, overlap: 2 },
      { changed: 10, overlap: 2 }, { changed: 8, overlap: 2 }, { changed: 6, overlap: 0 },
    ] });
  });

  it('removes the third PR without changing the repository topology', () => {
    const before = createDemoSnapshot();
    expect(footprint(['pr-248', 'pr-251'])).toEqual({ unique: 57, overlap: 2, groups: 6, byGroup: [
      { changed: 16, overlap: 0 }, { changed: 14, overlap: 0 }, { changed: 10, overlap: 1 },
      { changed: 10, overlap: 0 }, { changed: 5, overlap: 1 }, { changed: 2, overlap: 0 },
    ] });
    expect(createDemoSnapshot()).toEqual(before);
  });

  it('matches the two-commit activity union with five affected islands', () => {
    const snapshot = createDemoSnapshot();
    expect(snapshot.sources.filter((source) => source.kind === 'commit').map((source) => source.files.length)).toEqual([14, 14]);
    expect(footprint(DEMO_COMMIT_SOURCE_IDS)).toEqual({ unique: 24, overlap: 4, groups: 5, byGroup: [
      { changed: 8, overlap: 2 }, { changed: 6, overlap: 1 }, { changed: 5, overlap: 1 },
      { changed: 3, overlap: 0 }, { changed: 2, overlap: 0 }, { changed: 0, overlap: 0 },
    ] });
  });

  it('keeps source membership and source change lists in agreement', () => {
    const snapshot = createDemoSnapshot();
    for (const node of snapshot.nodes) {
      expect([...node.sourceIds].sort()).toEqual(snapshot.sources.filter((source) => source.files.some((file) => file.fileId === node.id)).map((source) => source.id).sort());
    }
    const changed = snapshot.sources.flatMap((source) => source.files);
    expect(changed.some((file) => file.status === 'renamed' && file.previousPath)).toBe(true);
    expect(changed.some((file) => file.status === 'deleted')).toBe(true);
    expect(changed.some((file) => file.status === 'added')).toBe(true);
    expect(changed.filter((file) => file.status === 'added').every((file) => file.deletions === 0)).toBe(true);
    expect(changed.filter((file) => file.status === 'deleted').every((file) => file.additions === 0)).toBe(true);
  });

  it('returns isolated, byte-stable copies', () => {
    const expected = JSON.stringify(createDemoSnapshot());
    const mutated = createDemoSnapshot();
    mutated.groups[0]!.label = 'Changed';
    mutated.nodes[0]!.sourceIds = [];
    expect(JSON.stringify(createDemoSnapshot())).toBe(expected);
  });
});

describe('seeded scale fixtures', () => {
  it.each([[2_000, 8_000], [10_000, 40_000]])('produces an exact valid %i-file/%i-edge graph', (nodeCount, edgeCount) => {
    const snapshot = validateGraphSnapshot(createScaleFixture(nodeCount, edgeCount, 17));
    expect(snapshot.nodes).toHaveLength(nodeCount);
    expect(snapshot.edges).toHaveLength(edgeCount);
    expect(snapshot.edges.every((edge) => edge.source !== edge.target)).toBe(true);
    expect(new Set(snapshot.edges.map((edge) => `${edge.source}:${edge.target}`)).size).toBe(edgeCount);
  });

  it('repeats identical seeds exactly and changes topology for a different seed', () => {
    expect(createScaleFixture(100, 400, 13)).toEqual(createScaleFixture(100, 400, 13));
    expect(createScaleFixture(100, 400, 13).edges).not.toEqual(createScaleFixture(100, 400, 14).edges);
  });

  it('handles the dense small graph and isolated one-file graph', () => {
    expect(validateGraphSnapshot(createScaleFixture(3, 6, 0)).edges).toHaveLength(6);
    expect(validateGraphSnapshot(createScaleFixture(1, 0)).nodes).toHaveLength(1);
  });

  it('rejects unsupported or impossible requested sizes', () => {
    expect(() => createScaleFixture(0, 0)).toThrow(RangeError);
    expect(() => createScaleFixture(2, 3)).toThrow(RangeError);
    expect(() => createScaleFixture(100, -1)).toThrow(RangeError);
    expect(() => createScaleFixture(100, 300, 1.2)).toThrow(RangeError);
  });
});
