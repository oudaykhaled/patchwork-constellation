import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { demoSnapshot } from '@patchwork/fixtures';
import type { ChangeSource, GraphSnapshot } from '@patchwork/contracts';
import { connectionEvidence, diffLink, fileAvailability, findFiles, groupBreadcrumb, importReferences, selectedHeadEvidence, sourceFileLink, sourceLink, textReasons } from './file-evidence';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const live: GraphSnapshot = { ...demoSnapshot, mode: 'github', contextSha: head, repository: { ...demoSnapshot.repository, owner: 'example', name: 'repo', fullName: 'example/repo' } };
const change = { fileId: 'file', path: 'src/new name.ts', previousPath: 'src/old.ts', status: 'renamed' as const, additions: 4, deletions: 2 };
const source: ChangeSource = { id: 'pr:1', kind: 'pr', number: 1, label: '#1', title: 'Rename', url: 'https://evil.invalid/untrusted', baseSha: base, headSha: head, comparisonKind: 'merge-base', files: [change] };

describe('file review evidence', () => {
  it('pins the exact comparison and hashes the new filename rather than the old rename path', async () => {
    expect(await diffLink(live, source, change)).toBe(`https://github.com/example/repo/compare/${base}..${head}#diff-${createHash('sha256').update(change.path).digest('hex')}`);
    expect(await diffLink(live, { ...source, kind: 'commit', comparisonKind: 'first-parent' }, change)).toContain(`/compare/${base}..${head}#diff-`);
    expect(await diffLink(live, { ...source, kind: 'commit', comparisonKind: 'empty-tree', baseSha: undefined }, change)).toContain(`/commit/${head}#diff-`);
  });
  it('disables synthetic, unpinned and unsafe destinations', async () => {
    expect(await diffLink(demoSnapshot, source, change)).toBeUndefined();
    expect(await diffLink(live, { ...source, baseSha: undefined }, change)).toBeUndefined();
    expect(await diffLink(live, { ...source, headSha: 'main' }, change)).toBeUndefined();
    expect(sourceLink(live, source)).toBe('https://github.com/example/repo/pull/1');
    expect(sourceFileLink(live, '../secrets.ts')).toBeUndefined();
    expect(sourceFileLink(live, 'a b/файл.ts', head, 7)).toBe(`https://github.com/example/repo/blob/${head}/a%20b/%D1%84%D0%B0%D0%B9%D0%BB.ts#L7`);
    expect(sourceFileLink({ ...live, repository: { ...live.repository, owner: 'bad/owner' } }, 'a.ts')).toBeUndefined();
  });
  it('finds duplicate basenames with deterministic full path context and trimmed queries', () => {
    const nodes = [ { ...live.nodes[0]!, id: 'b', path: 'beta/index.ts' }, { ...live.nodes[0]!, id: 'a', path: 'alpha/index.ts' }, { ...live.nodes[0]!, id: 'c', path: 'alpha/index.tsx' } ];
    expect(findFiles({ ...live, nodes }, ' INDEX.TS ').map(file => file.path)).toEqual(['alpha/index.ts', 'beta/index.ts', 'alpha/index.tsx']);
    expect(findFiles({ ...live, nodes }, 'beta/').map(file => file.id)).toEqual(['b']);
    expect(findFiles(live, 'missing')).toEqual([]);
  });
  it('exposes absent, binary, unsupported and stale states without treating no edge as no dependency', () => {
    const file = { ...live.nodes[0]!, path: 'assets/banner.png', status: 'binary' as const, presence: 'deleted' as const, importCoverage: 'unsupported' };
    const messages = fileAvailability({ ...live, stale: true }, file, []);
    expect(messages.join(' ')).toMatch(/Removed file/);
    expect(messages.join(' ')).toMatch(/Binary or asset/);
    expect(messages.join(' ')).toMatch(/Unsupported parser/);
    expect(messages.join(' ')).toMatch(/Stale snapshot/);
  });
  it('reports edge resolver/ref/line and group ancestry without traversing cycles', () => {
    const evidence = connectionEvidence(live, { id: 'e', source: 'a', target: 'b', kind: 'type-import', evidence: { path: 'src/a.ts', line: 9, resolver: 'typescript-ast', snapshotSha: base, specifier: './b' } });
    expect(evidence.text).toContain('typescript-ast');
    expect(evidence.url).toBe(`https://github.com/example/repo/blob/${base}/src/a.ts#L9`);
    expect(connectionEvidence(live, { id: 'e', source: 'a', target: 'b', kind: 'import' }).text).toContain('unavailable');
    expect(groupBreadcrumb([{ id: 'a', label: 'Component', parentId: 'b' }, { id: 'b', label: 'Package', parentId: 'a' }], 'a')).toBe('Package / Component');
  });
  it('keeps verified selected-head edges independent of context and rejects foreign or stale evidence', () => {
    const file = live.nodes[0]!, target = live.nodes[1]!;
    const edge: NonNullable<ChangeSource['importEdges']>[number] = { id: 'head-edge', source: file.id, target: target.id, kind: 'type-import', provenance: 'selected-head', sourceId: source.id, evidence: { path: file.path, line: 7, resolver: 'typescript-ast', sourceId: source.id, snapshotSha: head } };
    const enriched: ChangeSource = { ...source, importHeadSha: head, importCoverage: { status: 'partial', reasons: ['Outgoing changed-file imports only.'] }, importFiles: [{ fileId: file.id, path: file.path, status: 'partial', reasons: ['Missing target identity.'] }], importEdges: [edge, { ...edge, id: 'foreign', sourceId: 'other-pr' }, { ...edge, id: 'dangling', target: 'unknown-file' }] };
    const contextEdges = live.edges.length;
    const result = selectedHeadEvidence(live, enriched, file);
    expect(result).toMatchObject({ status: 'partial', pinned: true, fileStatus: 'partial', fileReasons: ['Missing target identity.'], rejectedEdges: 2 });
    expect(result.edges.map(item => item.id)).toEqual(['head-edge']);
    expect(live.edges).toHaveLength(contextEdges);
    const stale = selectedHeadEvidence(live, { ...enriched, importHeadSha: base }, file);
    expect(stale.edges).toEqual([]);
    expect(stale.fileStatus).toBe('unavailable');
    expect(stale.fileReasons.join(' ')).toContain('different source revision');
  });
  it('retains external/unresolved metadata as text and ignores malformed optional values', () => {
    expect(importReferences([{ specifier: 'react', line: 4, reason: 'External package' }, { specifier: '../missing', line: -1 }, { specifier: { injected: true } }, null])).toEqual([{ specifier: 'react', line: 4, reason: 'External package' }, { specifier: '../missing' }]);
    expect(textReasons(['Source budget reached.', { invalid: true }])).toEqual(['Source budget reached.']);
  });
});
