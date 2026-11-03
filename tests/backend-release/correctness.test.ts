import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeRepository, listRepositorySources, loadSourceChanges } from '@patchwork/analysis';
import { createSelectionFootprint, validateGraphSnapshot } from '@patchwork/contracts';
import { clearGitHubCacheForTests } from '@patchwork/github';
import { declaredChanges, gitCorpus } from './git-corpus';

const temporaryDirectories: string[] = [];
beforeEach(() => clearGitHubCacheForTests());
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map(path => {
  const target = resolve(path);
  if (dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(target).startsWith('constellation-release-')) throw new Error('Refusing cleanup outside the authored temporary corpus');
  return rm(target, { recursive: true, force: true, maxRetries: 3 });
})); });
async function corpus(options: Parameters<typeof gitCorpus>[1] = {}) { const path = await mkdtemp(join(tmpdir(), 'constellation-release-')); temporaryDirectories.push(path); return gitCorpus(path, options); }

describe('Git-grounded backend release gate', () => {
  it('analyzes authored Git evidence and proves independent PR union, overlap, rename and delete counts', async () => {
    const fixture = await corpus();
    const snapshot = await analyzeRepository({ repository: 'fixture/corpus' }, { fetch: fixture.fetch });
    expect(snapshot.nodes.map(node => node.path).sort()).toEqual([...fixture.history.golden.rootPaths].sort());
    expect(snapshot.contextSha).toBe(fixture.history.refs.root);
    const selected = await loadSourceChanges(snapshot, 'pr', ['pr:2', 'pr:1'], { fetch: fixture.fetch });
    for (const [number, kind] of [[1, 'featureA'], [2, 'featureB']] as const) {
      const source = selected.sources.find(item => item.id === `pr:${number}`)!;
      expect(source.files.map(file => ({ path: file.path, status: file.status, ...(file.previousPath ? { previousPath: file.previousPath } : {}) })).sort((a, b) => a.path.localeCompare(b.path))).toEqual(declaredChanges(fixture.history, kind));
    }
    const footprint = createSelectionFootprint(selected, ['pr:1', 'pr:2']);
    expect(footprint.counts).toMatchObject({ changedFiles: 8, overlappingFiles: 1, overlappingSources: 2 });
    expect(footprint.files.filter(file => file.sourceIds.length > 1).map(file => selected.nodes.find(node => node.id === file.fileId)!.path)).toEqual([...fixture.history.golden.overlapPaths]);
    expect(selected.sources[0]!.files.find(file => file.status === 'renamed')?.fileId).toBe(snapshot.nodes.find(node => node.path === 'src/legacy.ts')!.id);
    expect(selected.sources[0]!.files.find(file => file.status === 'removed')?.fileId).toBe(snapshot.nodes.find(node => node.path === 'src/deleted.ts')!.id);
    const empty = await loadSourceChanges(selected, 'pr', [], { fetch: fixture.fetch });
    expect(empty.nodes.map(node => node.id)).toEqual(selected.nodes.map(node => node.id));
    expect(createSelectionFootprint(empty, []).counts.changedFiles).toBe(0);
    expect(validateGraphSnapshot(selected)).toBeDefined();
  });

  it('proves root and merge first-parent commit activity is distinct from a merged net delta', async () => {
    const fixture = await corpus();
    const snapshot = await analyzeRepository({ repository: 'fixture/corpus' }, { fetch: fixture.fetch });
    const rootId = `commit:${fixture.history.refs.root}`, mergeId = `commit:${fixture.history.refs.merge}`;
    const selected = await loadSourceChanges(snapshot, 'commit', [rootId, mergeId], { fetch: fixture.fetch });
    expect(selected.sources.find(source => source.id === rootId)).toMatchObject({ comparisonKind: 'empty-tree', files: expect.any(Array) });
    expect(selected.sources.find(source => source.id === mergeId)).toMatchObject({ comparisonKind: 'first-parent', mergeCommit: true, baseSha: fixture.history.refs.root });
    expect(createSelectionFootprint(selected, [rootId, mergeId]).counts).toMatchObject({ changedFiles: 9, overlappingFiles: 6 });
    expect(fixture.calls.filter(url => url.includes(`/compare/${fixture.history.refs.root}...${fixture.history.refs.merge}`))).toHaveLength(1);
  });

  it('ties every observed edge to pinned source text and reports unresolved imports as incomplete coverage', async () => {
    const fixture = await corpus();
    const snapshot = await analyzeRepository({ repository: 'fixture/corpus' }, { fetch: fixture.fetch });
    const paths = new Map(snapshot.nodes.map(node => [node.id, node.path]));
    expect(snapshot.edges).toHaveLength(1);
    for (const edge of snapshot.edges) {
      const evidence = edge.evidence;
      expect(typeof evidence).toBe('object');
      if (typeof evidence !== 'object' || !evidence) throw new Error('Missing evidence');
      expect(evidence).toMatchObject({ snapshotSha: snapshot.contextSha, path: paths.get(edge.source), line: 1, specifier: './shared', resolver: expect.any(String) });
      expect(paths.get(edge.target)).toBe('src/shared.ts');
      const text = await (await fixture.fetch(`https://raw.githubusercontent.com/fixture/corpus/${snapshot.contextSha}/${evidence.path}`)).text();
      expect(text.split('\n')[Number(evidence.line) - 1]).toContain(String(evidence.specifier));
    }
    expect(snapshot.coverage.status).toBe('partial');
    expect(snapshot.coverage.reasons.join(' ')).toMatch(/unresolved|could not be resolved/i);
    expect(snapshot.nodes.some(node => node.path === 'src/missing.ts')).toBe(false);
    const poisoned = structuredClone(snapshot);
    const observedEvidence = poisoned.edges[0]!.evidence;
    if (typeof observedEvidence !== 'object' || !observedEvidence) throw new Error('Missing edge evidence');
    poisoned.edges[0]!.evidence = { ...observedEvidence, snapshotSha: 'f'.repeat(40) };
    expect(() => validateGraphSnapshot(poisoned)).toThrow();
  });

  it('exercises actual paged discovery and visibly partial truncated inventory without inventing missing files', async () => {
    const fixture = await corpus({ truncated: true });
    const snapshot = await analyzeRepository({ repository: 'fixture/corpus' }, { fetch: fixture.fetch, maxSourceFiles: 0 });
    expect(snapshot.sources.filter(source => source.kind === 'pr')).toHaveLength(30);
    const next = await listRepositorySources('fixture/corpus', 'pr', 2, snapshot.contextSha, { fetch: fixture.fetch });
    expect(next.sources.map(source => source.id)).toEqual(['pr:31']);
    expect(next.nextPage).toBeNull();
    expect(snapshot.coverage.status).toBe('partial');
    expect(snapshot.coverage.reasons.join(' ')).toMatch(/truncat/i);
    expect(snapshot.nodes).toHaveLength(4);
  });
});
