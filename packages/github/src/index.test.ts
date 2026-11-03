import { describe, expect, it, beforeEach, vi } from 'vitest';
import { GitHubClient, GitHubError, clearGitHubCacheForTests, parseRepository } from './index';
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
  it('rejects oversized source before parsing and uses a fixed raw origin', async () => {
    const client = new GitHubClient({ fetch: vi.fn(async () => new Response('large', { headers: { 'content-length': '1000000' } })) as typeof fetch });
    await expect(client.source(parseRepository('acme/tool'), 'a'.repeat(40), 'src/a.ts', 100)).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
    await expect(client.source(parseRepository('acme/tool'), 'a'.repeat(40), '../secret')).rejects.toMatchObject({ code: 'INVALID_SOURCE_PATH' });
  });
});
