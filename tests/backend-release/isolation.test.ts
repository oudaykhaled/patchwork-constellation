import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRepository } from '@patchwork/analysis';
import { createScaleFixture } from '@patchwork/fixtures';
import { GitHubClient, clearGitHubCacheForTests, parseRepository } from '@patchwork/github';
import { createStore, newJob } from '@patchwork/storage';
import { parseGitDiff } from '../../packages/analysis/src/git-fallback';

beforeEach(() => clearGitHubCacheForTests());
describe('backend retention and input release gate', () => {
  it('does not retain another account source overlays or jobs after a scoped removal', async () => {
    let now = Date.parse('2026-11-03T00:00:00Z');
    const store = await createStore({ databaseUrl: '', retentionMs: 1_000, now: () => now });
    const graph = createScaleFixture(212, 235, 42);
    const alice = { ownerId: 'alice', repository: graph.repository.fullName }, bob = { ...alice, ownerId: 'bob' };
    try {
      await store.putSnapshot(alice, graph); await store.putSnapshot(bob, graph);
      await store.putJob(alice, newJob({ snapshotId: graph.id }, { id: 'same-job', now }));
      await store.putJob(bob, newJob({ snapshotId: graph.id }, { id: 'same-job', now }));
      await store.recordWebhookDelivery(alice, 'same-delivery'); await store.recordWebhookDelivery(bob, 'same-delivery');
      expect(await store.getSnapshot({ ...alice, repository: 'other/repository' }, graph.id)).toBeUndefined();
      await store.deleteRepository(alice);
      expect(await store.getSnapshot(alice, graph.id)).toBeUndefined();
      expect(await store.getJob(alice, 'same-job')).toBeUndefined();
      expect((await store.getSnapshot(bob, graph.id))?.sources[0]?.files.length).toBeGreaterThan(0);
      expect(await store.getJob(bob, 'same-job')).toBeDefined();
      expect(await store.recordWebhookDelivery(alice, 'same-delivery')).toBe(true);
      expect(await store.recordWebhookDelivery(bob, 'same-delivery')).toBe(false);
      now += 1_001; await store.prune();
      expect(await store.getSnapshot(bob, graph.id)).toBeUndefined();
      expect(await store.getJob(bob, 'same-job')).toBeUndefined();
      expect(await store.recordWebhookDelivery(bob, 'same-delivery')).toBe(true);
    } finally { await store.close(); }
  });

  it('evicts bounded gateway cache entries and isolates the same immutable URL by credential', async () => {
    let calls = 0;
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => { calls++; return Response.json({ identity: new Headers(init?.headers).get('Authorization') ?? 'public' }); }) as typeof fetch;
    const alice = new GitHubClient({ token: 'synthetic-alice', fetch: fetcher }), bob = new GitHubClient({ token: 'synthetic-bob', fetch: fetcher });
    const first = '/repos/fixture/corpus/git/trees/first';
    expect(await alice.get(first, true)).toEqual({ identity: 'Bearer synthetic-alice' });
    expect(await alice.get(first, true)).toEqual({ identity: 'Bearer synthetic-alice' });
    expect(await bob.get(first, true)).toEqual({ identity: 'Bearer synthetic-bob' });
    expect(calls).toBe(2);
    for (let index = 0; index < 301; index++) await alice.get(`/repos/fixture/corpus/git/trees/item-${index}`, true);
    const before = calls; await alice.get(first, true);
    expect(calls).toBe(before + 1);
  });

  it('rejects unsafe source/object/destination paths before transport and bounds a lying source response', async () => {
    const transport = vi.fn(async () => new Response('x'.repeat(80_001))) as unknown as typeof fetch;
    const client = new GitHubClient({ fetch: transport });
    for (const path of ['../secrets.ts', 'src/../../secret', '/absolute.ts', 'src\\secret.ts', 'src/\0secret.ts']) await expect(client.source(parseRepository('fixture/corpus'), 'a'.repeat(40), path)).rejects.toMatchObject({ code: 'INVALID_SOURCE_PATH' });
    expect(transport).not.toHaveBeenCalled();
    await expect(client.source(parseRepository('fixture/corpus'), 'a'.repeat(40), 'src/main.ts')).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
    expect(transport).toHaveBeenCalledOnce();
    expect(() => parseRepository('https://github.com@evil.example/fixture/corpus')).toThrow();
    expect(() => parseGitDiff(Buffer.from('A\0../../escape\0'), Buffer.from('1\t0\t../../escape\0'))).toThrow();
  });

  it('keeps oversized source inventoried without downloading it and never executes malformed text', async () => {
    const sha = 'a'.repeat(40), rawPaths: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === 'raw.githubusercontent.com') { rawPaths.push(url.pathname); return new Response("import { ; << SCRIPT_THAT_MUST_REMAIN_DATA\n"); }
      if (url.pathname === '/repos/fixture/corpus') return Response.json({ name: 'corpus', full_name: 'fixture/corpus', private: false, default_branch: 'main', html_url: 'https://github.com/fixture/corpus', owner: { login: 'fixture' } });
      if (url.pathname.startsWith('/repos/fixture/corpus/commits/')) return Response.json({ sha, commit: { message: 'fixture' }, parents: [] });
      if (url.pathname.includes('/git/trees/')) return Response.json({ tree: [{ path: 'src/oversized.ts', mode: '100644', type: 'blob', sha: 'b'.repeat(40), size: 80_001 }, { path: 'src/malformed.ts', mode: '100644', type: 'blob', sha: 'c'.repeat(40), size: 45 }, { path: '../../escape.ts', mode: '100644', type: 'blob', sha: 'd'.repeat(40), size: 1 }, { path: 'src/link.ts', mode: '120000', type: 'blob', sha: 'e'.repeat(40), size: 8 }], truncated: false });
      return Response.json([]);
    }) as typeof fetch;
    const snapshot = await analyzeRepository({ repository: 'fixture/corpus' }, { fetch: fetcher });
    expect(snapshot.nodes).toHaveLength(3);
    expect(snapshot.nodes.some(node => node.path.includes('..'))).toBe(false);
    expect(snapshot.nodes.find(node => node.path === 'src/link.ts')).toMatchObject({ fileKind: 'symlink', importCoverage: 'excluded' });
    expect(snapshot.nodes.find(node => node.path === 'src/malformed.ts')).toMatchObject({ importCoverage: 'partial' });
    expect(rawPaths).toHaveLength(1); expect(rawPaths[0]).toContain('src/malformed.ts');
    expect(snapshot.edges).toHaveLength(0);
    expect(snapshot.coverage.status).toBe('partial');
    expect(snapshot.coverage.reasons.join(' ')).toMatch(/oversized|80KB|80,000/);
    expect(JSON.stringify(snapshot)).not.toContain('SCRIPT_THAT_MUST_REMAIN_DATA');
  });
});
