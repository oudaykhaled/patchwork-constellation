import { describe, expect, it, beforeEach, vi } from 'vitest';
import { GitHubClient, GitHubError, clearGitHubCacheForTests, invalidateGitHubRepositoryCache, purgeGitHubRepositoryCache, parseRepository, type GitHubTelemetry } from './index';
beforeEach(() => clearGitHubCacheForTests());
describe('repository addressing and outbound boundaries', () => {
  it('accepts only repository identifiers or exact HTTPS GitHub URLs', () => {
    expect(parseRepository('https://github.com/acme/tool.git')).toEqual({ owner: 'acme', name: 'tool', fullName: 'acme/tool' });
    for (const value of ['https://evil.test/acme/tool', 'http://github.com/acme/tool', 'https://github.com@evil.test/acme/tool', 'https://github.com/acme/tool?token=x', 'acme/../tool', 'https://github.com/acme/tool/tree/main']) expect(() => parseRepository(value)).toThrow(GitHubError);
  });
  it('never dispatches arbitrary API origins', async () => {
    const fetcher = vi.fn(); const client = new GitHubClient({ fetch: fetcher });
    await expect(client.get('https://evil.test/repos/a/b')).rejects.toThrow('Invalid GitHub API path');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps caches isolated by token and never sends authorization to raw content', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({ auth: (init?.headers as Record<string, string>).Authorization }), { status: 200 }));
    const a = new GitHubClient({ token: 'token-a', fetch: fetcher as typeof fetch }); const b = new GitHubClient({ token: 'token-b', fetch: fetcher as typeof fetch });
    expect(await a.get('/repos/acme/tool')).toEqual({ auth: 'Bearer token-a' });
    expect(await b.get('/repos/acme/tool')).toEqual({ auth: 'Bearer token-b' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const rawFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { expect(init?.headers).toBeUndefined(); return new Response('export {}'); });
    await new GitHubClient({ token: 'secret', fetch: rawFetch as typeof fetch }).source(parseRepository('acme/tool'), 'a'.repeat(40), 'src/index.ts');
    expect(rawFetch.mock.calls[0]?.[0]).toContain('https://raw.githubusercontent.com/acme/tool/');
  });
  it('reports quota exhaustion with retry guidance', async () => {
    const client = new GitHubClient({ fetch: vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '20' } })) as typeof fetch });
    await expect(client.get('/repos/acme/tool')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 20 });
  });
  it('reads authorized private source through the fixed Contents API with a scoped server token', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`https://api.github.com/repos/acme/tool/contents/src/a.ts?ref=${'a'.repeat(40)}`);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer installation-test');
      expect(init?.redirect).toBe('error');
      return new Response('export {}');
    });
    expect(await new GitHubClient({ token: 'installation-test', allowPrivate: true, fetch: fetcher as typeof fetch }).source(parseRepository('acme/tool'), 'a'.repeat(40), 'src/a.ts')).toBe('export {}');
  });
  it('rejects oversized source before parsing and uses a fixed raw origin', async () => {
    const client = new GitHubClient({ fetch: vi.fn(async () => new Response('large', { headers: { 'content-length': '1000000' } })) as typeof fetch });
    await expect(client.source(parseRepository('acme/tool'), 'a'.repeat(40), 'src/a.ts', 100)).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
    await expect(client.source(parseRepository('acme/tool'), 'a'.repeat(40), '../secret')).rejects.toMatchObject({ code: 'INVALID_SOURCE_PATH' });
  });
});

describe('bounded ingestion replay', () => {
  it('uses conditional requests and preserves the authoritative pagination Link across 304', async () => {
    const events: GitHubTelemetry[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1) return Response.json([1, 2], { headers: { etag: '"page1"', link: '<https://api.github.com/repos/acme/tool/pulls?page=2>; rel="next"' } });
      expect((init?.headers as Record<string, string>)['If-None-Match']).toBe('"page1"');
      return new Response(null, { status: 304 });
    });
    const client = new GitHubClient({ fetch: fetcher as typeof fetch, cacheTtlMs: 0, onTelemetry: event => events.push(event) });
    expect(await client.page('/repos/acme/tool/pulls?state=open', 1, 2)).toEqual({ items: [1, 2], nextPage: 2 });
    expect(await client.page('/repos/acme/tool/pulls?state=open', 1, 2)).toEqual({ items: [1, 2], nextPage: 2 });
    expect(events.some(event => event.event === 'conditional-hit')).toBe(true);
  });
  it('respects final-page Link even when a page is full and does not follow supplied origins', async () => {
    const fetcher = vi.fn(async () => Response.json([1, 2], { headers: { link: '<https://evil.test/private>; rel="prev"' } }));
    const client = new GitHubClient({ fetch: fetcher as typeof fetch });
    expect((await client.page('/repos/acme/tool/commits', 2, 2)).nextPage).toBeNull();
    expect(fetcher.mock.calls).toHaveLength(1);
    expect((await client.page('/repos/acme/tool/commits', 100, 2)).nextPage).toBeNull();
  });
  it('retries a short Retry-After without shortening it, with bounded exponential retries', async () => {
    const events: GitHubTelemetry[] = [];
    const fetcher = vi.fn(async () => fetcher.mock.calls.length < 3 ? new Response(null, { status: 503, headers: { 'retry-after': '0.01' } }) : Response.json({ ok: true }));
    expect(await new GitHubClient({ fetch: fetcher as typeof fetch, onTelemetry: event => events.push(event) }).get('/repos/acme/tool')).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(events.filter(event => event.event === 'retry').map(event => event.waitMs)).toEqual([10, 10]);
  });
  it('returns reset guidance when the required rate-limit wait exceeds the retry budget', async () => {
    const reset = Math.ceil(Date.now() / 1_000) + 120;
    const fetcher = vi.fn(async () => new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }));
    await expect(new GitHubClient({ fetch: fetcher as typeof fetch }).get('/repos/acme/tool')).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    try { await new GitHubClient({ fetch: fetcher as typeof fetch }).get('/repos/acme/tool'); } catch (error) { expect((error as GitHubError).retryAfter).toBeGreaterThanOrEqual(119); }
  });
  it('honors HTTP-date Retry-After and finite retry limits', async () => {
    const later = new Date(Date.now() + 120_000).toUTCString();
    const limited = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': later } }));
    await expect(new GitHubClient({ fetch: limited as typeof fetch }).get('/repos/acme/tool')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited).toHaveBeenCalledTimes(1);
    const transient = vi.fn(async () => new Response(null, { status: 503, headers: { 'retry-after': '0' } }));
    await expect(new GitHubClient({ fetch: transient as typeof fetch, maxRetries: 1 }).get('/repos/acme/tool')).rejects.toMatchObject({ status: 503 });
    expect(transient).toHaveBeenCalledTimes(2);
  });
  it('classifies secondary rate limits separately from access denial, auth, missing and network errors', async () => {
    for (const [status, code, body] of [[403, 'ACCESS_DENIED', '{}'], [401, 'AUTH_FAILED', '{}'], [404, 'NOT_FOUND', '{}'], [403, 'RATE_LIMITED', '{"message":"secondary rate limit exceeded"}']] as const) {
      const fetcher = vi.fn(async () => new Response(body, { status }));
      await expect(new GitHubClient({ fetch: fetcher as typeof fetch, maxRetries: 0 }).get('/repos/acme/tool')).rejects.toMatchObject({ code, status });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    await expect(new GitHubClient({ fetch: vi.fn(async () => { throw new Error('secret-network-data'); }) as typeof fetch, maxRetries: 0 }).get('/repos/acme/tool')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
  it('shares one in-flight request while cancellation remains independent for each subscriber', async () => {
    let resolve!: (response: Response) => void;
    let transportSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { transportSignal = init?.signal as AbortSignal; return new Promise<Response>(r => { resolve = r; }); });
    const cancel = new AbortController();
    const a = new GitHubClient({ fetch: fetcher as typeof fetch, signal: cancel.signal });
    const b = new GitHubClient({ fetch: fetcher as typeof fetch });
    const first = a.get('/repos/acme/tool'); const second = b.get('/repos/acme/tool');
    await Promise.resolve(); await Promise.resolve();
    cancel.abort(); await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(false);
    resolve(Response.json({ ok: true })); expect(await second).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('aborts transport when all subscribers cancel and a later subscriber can retry', async () => {
    const cancel = new AbortController();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })));
    const request = new GitHubClient({ fetch: fetcher as typeof fetch, signal: cancel.signal }).get('/repos/acme/tool');
    await Promise.resolve(); await Promise.resolve(); cancel.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    const retry = new GitHubClient({ fetch: vi.fn(async () => Response.json({ retried: true })) as typeof fetch });
    expect(await retry.get('/repos/acme/tool')).toEqual({ retried: true });
  });
  it('serializes different requests per credential and removes canceled queued work', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1 ? new Promise<Response>(r => { resolve = r; }) : Response.json({ ok: true }));
    const client = new GitHubClient({ fetch: fetcher as typeof fetch });
    const first = client.get('/repos/acme/tool');
    const canceled = new AbortController();
    const second = new GitHubClient({ fetch: fetcher as typeof fetch, signal: canceled.signal }).get('/repos/acme/other');
    const third = client.get('/repos/acme/third');
    await Promise.resolve(); await Promise.resolve(); expect(fetcher).toHaveBeenCalledTimes(1);
    canceled.abort(); await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    resolve(Response.json({ ok: true })); await first; await third;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('cancels a retry wait before another network request', async () => {
    const cancel = new AbortController();
    const fetcher = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': '1' } }));
    const request = new GitHubClient({ fetch: fetcher as typeof fetch, signal: cancel.signal, onTelemetry: event => { if (event.event === 'retry') cancel.abort(); } }).get('/repos/acme/tool');
    await expect(request).rejects.toMatchObject({ name: 'AbortError' }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('caches immutable raw sources by repository, credential, SHA, path and size bound', async () => {
    const fetcher = vi.fn(async () => new Response('export {}'));
    const client = new GitHubClient({ fetch: fetcher as typeof fetch }); const address = parseRepository('acme/tool');
    await client.source(address, 'a'.repeat(40), 'src/a.ts'); await client.source(address, 'a'.repeat(40), 'src/a.ts');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.source(address, 'b'.repeat(40), 'src/a.ts'); expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(client.source(address, 'b'.repeat(40), 'src/a.ts', 3)).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
  });
  it('expires only mutable metadata for a repository on refresh', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true })); const client = new GitHubClient({ fetch: fetcher as typeof fetch });
    await client.get('/repos/acme/tool'); await client.get('/repos/acme/tool/git/trees/' + 'a'.repeat(40), true); await client.get('/repos/acme/other');
    expect(invalidateGitHubRepositoryCache('acme/tool')).toBe(1);
    await client.get('/repos/acme/tool'); await client.get('/repos/acme/tool/git/trees/' + 'a'.repeat(40), true); await client.get('/repos/acme/other');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('a webhook invalidation prevents an older in-flight mutable ref from refilling the cache', async () => {
    let complete!: (value: Response) => void;
    const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1 ? new Promise<Response>(resolve => { complete = resolve; }) : Response.json({ sha: 'current-head' }));
    const client = new GitHubClient({ fetch: fetcher as typeof fetch });
    const pending = client.get('/repos/acme/tool/commits/main').catch(error => error);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(invalidateGitHubRepositoryCache('acme/tool')).toBe(1);
    complete(Response.json({ sha: 'outdated-head' })); expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(await client.get('/repos/acme/tool/commits/main')).toEqual({ sha: 'current-head' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('revocation purges immutable private responses while retaining unrelated repository caches', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true })), client = new GitHubClient({ token: 'synthetic-private-token', fetch: fetcher as typeof fetch });
    await client.get('/repos/acme/tool/git/trees/' + 'a'.repeat(40), true); await client.get('/repos/acme/other', true);
    expect(purgeGitHubRepositoryCache('acme/tool')).toBe(1);
    await client.get('/repos/acme/tool/git/trees/' + 'a'.repeat(40), true); await client.get('/repos/acme/other', true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('emits source-free quota, cache and truncation/cap telemetry', async () => {
    const events: GitHubTelemetry[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => Response.json(String(url).includes('compare') ? { files: Array(300).fill({ filename: 'secret-source.ts' }) } : { tree: [], truncated: true }, { headers: { 'x-ratelimit-remaining': '23', 'x-ratelimit-limit': '60' } }));
    const client = new GitHubClient({ token: 'secret-token', fetch: fetcher as typeof fetch, onTelemetry: event => events.push(event) });
    await client.get('/repos/private-name/tool/git/trees/' + 'a'.repeat(40), true); await client.get('/repos/private-name/tool/compare/a...b'); await client.get('/repos/private-name/tool/compare/a...b');
    expect(events).toContainEqual(expect.objectContaining({ event: 'coverage', reason: 'recursive-tree-truncated' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'coverage', reason: 'comparison-file-cap' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'request', remaining: 23, limit: 60 }));
    expect(events.some(event => event.event === 'cache-hit')).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/secret|private-name|https:|filename/);
  });
});
