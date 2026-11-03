import { authoredFileFacts } from '@patchwork/fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeSource, GraphSnapshot } from '@patchwork/contracts';
import { clearGitHubCacheForTests } from '@patchwork/github';
import { loadSourceChanges } from './footprints';
import { EMPTY_GIT_TREE } from './git-fallback';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const pr = (number: number, base = A, head = B): ChangeSource => ({ id: `pr:${number}`, kind: 'pr', number, title: `PR ${number}`, label: `#${number}`, url: `https://github.com/acme/tool/pull/${number}`, files: [], baseSha: base, headSha: head, comparisonKind: 'merge-base', loaded: false });
const commit = (sha: string, parent = A): ChangeSource => ({ id: `commit:${sha}`, kind: 'commit', sha, headSha: sha, baseSha: parent, comparisonKind: parent === EMPTY_GIT_TREE ? 'empty-tree' : 'first-parent', title: 'Commit', label: sha.slice(0, 7), url: `https://github.com/acme/tool/commit/${sha}`, files: [], loaded: false });
function snapshot(sources: ChangeSource[]): GraphSnapshot {
  return { schemaVersion: '1', id: 'snapshot:fixture', contextSha: A, contextRef: 'main', repository: { owner: 'acme', name: 'tool', fullName: 'acme/tool', defaultBranch: 'main', htmlUrl: 'https://github.com/acme/tool' }, nodes: [{ ...authoredFileFacts('complete'), id: 'file:existing', path: 'src/existing.ts', groupId: 'folder:src', presence: 'context', sourceIds: [] }], edges: [], groups: [{ id: 'folder:src', label: 'src' }], sources, coverage: { status: 'complete', reasons: [] }, createdAt: '2026-01-01T00:00:00.000Z', mode: 'github' };
}
const fetcher = (respond: (url: URL) => unknown): typeof fetch => (async input => {
  const value = respond(new URL(String(input)));
  if (value === undefined) return new Response('', { status: 404 });
  return Response.json(value);
}) as typeof fetch;
const pull = (number = 1, base = A, head = B, changed = 1) => ({ number, title: 'PR', html_url: `https://github.com/acme/tool/pull/${number}`, state: 'open', changed_files: changed, updated_at: '2026-01-02T00:00:00Z', base: { sha: base, ref: 'main' }, head: { sha: head, ref: 'feature' } });
const modified = { filename: 'src/existing.ts', status: 'modified', additions: 2, deletions: 1 };

beforeEach(() => clearGitHubCacheForTests());
describe('independent source footprint semantics', () => {
  it('retains independent bases and per-source stats, including a revert as two touches', async () => {
    const input = snapshot([commit(B), commit(C, B)]);
    const result = await loadSourceChanges(input, 'commit', [`commit:${C}`, `commit:${B}`], { fetch: fetcher(url => url.pathname.includes(B) ? { sha: B, commit: { message: 'edit', committer: { date: '2026-01-01T01:00:00Z' } }, parents: [{ sha: A }], files: [modified] } : { sha: C, commit: { message: 'revert' }, parents: [{ sha: B }], files: [{ ...modified, additions: 1, deletions: 2 }] }) });
    expect(result.sources.map(source => [source.baseSha, source.headSha])).toEqual([[A, B], [B, C]]);
    expect(result.nodes[0]?.sourceIds).toHaveLength(2);
    expect(new Set(result.sources.flatMap(source => source.files.map(file => file.fileId))).size).toBe(1);
    expect(result.sources.map(source => [source.files[0]?.additions, source.files[0]?.deletions])).toEqual([[2, 1], [1, 2]]);
    expect(result.sources[0]?.comparedAt).toEqual(expect.any(String));
    expect(result.sources[0]?.version).not.toBe(result.sources[1]?.version);
    expect(input.sources[0]?.loaded).toBe(false);
  });

  it('uses explicit first-parent comparison for a merge instead of combined commit presentation', async () => {
    const seen: string[] = [];
    const result = await loadSourceChanges(snapshot([commit(B)]), 'commit', [`commit:${B}`], { fetch: fetcher(url => {
      seen.push(url.pathname);
      if (url.pathname.includes('/commits/')) return { sha: B, commit: { message: 'merge' }, parents: [{ sha: A }, { sha: C }], files: [{ filename: 'wrong-combined.ts', status: 'added' }] };
      if (url.pathname.includes('/compare/')) return { merge_base_commit: { sha: A }, files: [modified] };
    }) });
    expect(seen).toContain(`/repos/acme/tool/compare/${A}...${B}`);
    expect(result.sources[0]).toMatchObject({ mergeCommit: true, comparisonKind: 'first-parent', baseSha: A, headSha: B });
    expect(result.sources[0]?.files.map(file => file.path)).toEqual(['src/existing.ts']);
  });

  it('represents a root delta against the empty tree', async () => {
    const result = await loadSourceChanges(snapshot([commit(B, EMPTY_GIT_TREE)]), 'commit', [`commit:${B}`], { fetch: fetcher(() => ({ sha: B, commit: { message: 'root' }, parents: [], files: [{ ...modified, status: 'added', deletions: 0 }] })) });
    expect(result.sources[0]).toMatchObject({ comparisonKind: 'empty-tree', baseSha: EMPTY_GIT_TREE, headSha: B });
  });

  it('keeps confirmed rename/delete identity and determinism for reversed requested order', async () => {
    const run = (ids: string[]) => loadSourceChanges(snapshot([pr(1), pr(2, C, D)]), 'pr', ids, { fetch: fetcher(url => {
      if (url.pathname.endsWith('/pulls/1')) return pull();
      if (url.pathname.endsWith('/pulls/2')) return pull(2, C, D);
      if (url.pathname.includes(`${A}...${B}`)) return { merge_base_commit: { sha: A }, files: [{ filename: 'src/renamed.ts', previous_filename: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 }] };
      if (url.pathname.includes(`${C}...${D}`)) return { merge_base_commit: { sha: C }, files: [{ filename: 'src/old.ts', status: 'removed', additions: 0, deletions: 3 }] };
    }) });
    const one = await run(['pr:2', 'pr:1']); clearGitHubCacheForTests(); const two = await run(['pr:1', 'pr:2']);
    expect(one.sources[0]?.files[0]?.fileId).toBe(one.sources[1]?.files[0]?.fileId);
    expect(one.nodes.map(node => node.id)).toEqual(two.nodes.map(node => node.id));
    const empty = await loadSourceChanges(one, 'pr', [], { fetch: fetcher(() => undefined) });
    expect(empty.nodes.map(node => node.id)).toEqual(one.nodes.map(node => node.id));
  });

  it('uses pinned Git fallback for a 3001-file PR and does not paginate comparison files', async () => {
    const fallback = vi.fn(async () => [modified]); const urls: URL[] = [];
    const result = await loadSourceChanges(snapshot([pr(1)]), 'pr', ['pr:1'], { gitFallback: fallback, fetch: fetcher(url => {
      urls.push(url);
      if (url.pathname.endsWith('/pulls/1')) return pull(1, A, B, 3001);
      if (url.pathname.includes('/compare/')) return { merge_base_commit: { sha: C }, files: [modified] };
      if (url.pathname.endsWith('/files')) return [modified];
    }) });
    expect(fallback).toHaveBeenCalledWith({ repository: 'acme/tool', baseSha: C, headSha: B, signal: undefined });
    expect(urls.filter(url => url.pathname.includes('/compare/'))).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ coverage: { status: 'complete' }, fileEvidence: 'bounded-git-diff' });
  });

  it('keeps explicit partial results if 301-file merge fallback fails', async () => {
    const fallback = vi.fn(async () => { throw new Error('unavailable'); });
    const result = await loadSourceChanges(snapshot([commit(B)]), 'commit', [`commit:${B}`], { gitFallback: fallback, fetch: fetcher(url => url.pathname.includes('/commits/') ? { sha: B, commit: { message: 'merge' }, parents: [{ sha: A }, { sha: C }], files: [] } : { merge_base_commit: { sha: A }, files: Array.from({ length: 300 }, (_, i) => ({ filename: `file-${i}.ts`, status: 'added', additions: 1, deletions: 0 })) }) });
    expect(result.sources[0]?.coverage).toMatchObject({ status: 'partial' });
    expect(result.coverage.status).toBe('partial'); expect(fallback).toHaveBeenCalledOnce();
    expect(result.sources[0]?.files).toHaveLength(300);
  });

  it('rejects force-push and base changes without mutating the pinned source', async () => {
    const input = snapshot([pr(1)]);
    await expect(loadSourceChanges(input, 'pr', ['pr:1'], { fetch: fetcher(() => pull(1, A, D)) })).rejects.toMatchObject({ code: 'STALE_SOURCE' });
    expect(input.sources[0]?.headSha).toBe(B);
  });

  it('keeps same-path independent additions separate, including equal content and a third source', async () => {
    const input = snapshot([pr(1), pr(2), pr(3)]);
    const result = await loadSourceChanges(input, 'pr', ['pr:3', 'pr:1', 'pr:2'], { fetch: fetcher(url => {
      const match = /\/pulls\/(\d+)$/.exec(url.pathname);
      if (match) return pull(Number(match[1]));
      if (url.pathname.includes('/compare/')) return { merge_base_commit: { sha: A }, files: [{ filename: 'src/new.ts', status: 'added', sha: 'same-content', additions: 1, deletions: 0 }] };
    }) });
    expect(new Set(result.sources.map(source => source.files[0]?.fileId)).size).toBe(3);
    expect(result.coverage.reasons.join(' ')).toContain('shared lineage');
    for (const source of result.sources) {
      expect(source.files[0]!.status).toBe('added');
      expect(result.nodes.find(node => node.id === source.files[0]!.fileId)).toMatchObject({ fileKind: 'unknown', presence: 'source-only', status: 'unparsed', importCoverage: 'excluded' });
    }
  });

  it('source-only addition IDs do not depend on which source was loaded first', async () => {
    const fetch = fetcher(url => {
      const match = /\/pulls\/(\d+)$/.exec(url.pathname);
      if (match) return pull(Number(match[1]));
      if (url.pathname.includes('/compare/')) return { merge_base_commit: { sha: A }, files: [{ filename: 'new.ts', status: 'added', sha: 'same-blob', additions: 1, deletions: 0 }] };
    });
    const first = await loadSourceChanges(snapshot([pr(1), pr(2)]), 'pr', ['pr:2'], { fetch });
    const incremental = await loadSourceChanges(first, 'pr', ['pr:1', 'pr:2'], { fetch });
    const together = await loadSourceChanges(snapshot([pr(1), pr(2)]), 'pr', ['pr:1', 'pr:2'], { fetch });
    expect(incremental.sources.map(source => source.files[0]?.fileId)).toEqual(together.sources.map(source => source.files[0]?.fileId));
  });
});
