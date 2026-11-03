import { createHash } from 'node:crypto';
/** Read-only, public-repository GitHub gateway. Never executes repository code. */
export class GitHubError extends Error {
  constructor(message: string, public status = 500, public code = 'GITHUB_ERROR', public retryAfter?: number) {
    super(message); this.name = 'GitHubError';
  }
}

export interface GitHubOptions { token?: string; signal?: AbortSignal; fetch?: typeof fetch; }
export interface GitHubPage<T> { items: T[]; nextPage: number | null; }
export interface RepositoryAddress { owner: string; name: string; fullName: string; }

export function parseRepository(value: string): RepositoryAddress {
  let path = value.trim();
  if (/^https?:/i.test(path)) {
    let url: URL;
    try { url = new URL(path); } catch { throw new GitHubError('Enter a GitHub repository URL or owner/name.', 400, 'INVALID_REPOSITORY'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) {
      throw new GitHubError('Use an https://github.com/owner/repository URL.', 400, 'INVALID_REPOSITORY');
    }
    path = url.pathname.replace(/^\/+|\/+$/g, '');
  }
  path = path.replace(/\.git$/, '');
  const match = /^([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\/([a-zA-Z0-9_.-]{1,100})$/.exec(path);
  if (!match || match[2] === '.' || match[2] === '..') throw new GitHubError('Enter a repository as owner/name.', 400, 'INVALID_REPOSITORY');
  return { owner: match[1]!, name: match[2]!, fullName: `${match[1]}/${match[2]}` };
}

const cache = new Map<string, { value: unknown; etag?: string; expires: number }>();
const pending = new Map<string, Promise<unknown>>();
const API_VERSION = '2022-11-28';
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const boundedText = async (response: Response, max: number) => {
  if (Number(response.headers.get('content-length') ?? 0) > max) throw new GitHubError('GitHub response exceeds the configured size limit.', 413, 'RESPONSE_LIMIT');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) { await reader.cancel(); throw new GitHubError('GitHub response exceeds the configured size limit.', 413, 'RESPONSE_LIMIT'); } chunks.push(value); }
  const all = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(all);
};

export class GitHubClient {
  private fetcher: typeof fetch;
  private token?: string;
  constructor(private options: GitHubOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.token = options.token ?? (typeof process !== 'undefined' ? process.env.GITHUB_TOKEN : undefined);
  }
  async get<T>(path: string, immutable = false): Promise<T> {
    if (!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|\?|$)/.test(path) || path.split('?')[0]!.split('/').some(segment => decodeURIComponent(segment) === '..') || path.includes('\\') || path.includes('#')) throw new GitHubError('Invalid GitHub API path.', 400, 'INVALID_API_PATH');
    const url = new URL(path, 'https://api.github.com');
    if (url.origin !== 'https://api.github.com') throw new GitHubError('Invalid API origin.', 400);
    // Credentials never leave this fixed API origin. Cache keys do not include credential material.
    const scope = this.token ? `token:${createHash('sha256').update(this.token).digest('hex')}` : 'public';
    const key = `${scope}:${url.href}`;
    const old = cache.get(key);
    if (old && old.expires > Date.now()) return structuredClone(old.value) as T;
    if (pending.has(key)) return structuredClone(await pending.get(key)) as T;
    const work = (async () => {
      this.options.signal?.throwIfAborted();
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'Patchwork-Constellation' };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (old?.etag) headers['If-None-Match'] = old.etag;
      let response: Response;
      try { response = await this.fetcher(url.href, { headers, signal: this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: 'error' }); }
      catch (error) { if (this.options.signal?.aborted) throw error; throw new GitHubError('GitHub could not be reached. Retry the analysis.', 502, 'NETWORK_ERROR'); }
      if (response.status === 304 && old) { old.expires = Date.now() + 60_000; return old.value; }
      if (!response.ok) {
        const retryHeader = response.headers.get('retry-after');
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        const retry = retryHeader ? Number(retryHeader) : reset ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : undefined;
        if (response.status === 403 || response.status === 429) throw new GitHubError('GitHub is limiting requests. Try again after the quota resets, or configure a server-side GITHUB_TOKEN.', response.status, 'RATE_LIMITED', retry);
        if (response.status === 404) throw new GitHubError('Public repository or revision not found. Check its name and access.', 404, 'NOT_FOUND');
        if (response.status === 401) throw new GitHubError('The server GitHub token is invalid or expired.', 401, 'AUTH_FAILED');
        throw new GitHubError(`GitHub returned ${response.status}. Retry the analysis.`, response.status);
      }
      let value: unknown;
      try { value = JSON.parse(await boundedText(response, MAX_RESPONSE_BYTES)); } catch (error) { if (error instanceof GitHubError) throw error; throw new GitHubError('GitHub returned an invalid response.', 502, 'INVALID_RESPONSE'); }
      if (cache.size >= 300) cache.delete(cache.keys().next().value!);
      cache.set(key, { value, etag: response.headers.get('etag') ?? undefined, expires: Date.now() + (immutable ? 15 * 60_000 : 60_000) });
      return value;
    })();
    pending.set(key, work);
    try { return structuredClone(await work) as T; } finally { pending.delete(key); }
  }
  async page<T>(path: string, page = 1, perPage = 30): Promise<GitHubPage<T>> {
    if (!Number.isInteger(page) || page < 1 || page > 100 || !Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new GitHubError('Invalid pagination.', 400);
    const items = await this.get<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`);
    if (!Array.isArray(items)) throw new GitHubError('GitHub returned an invalid list.', 502, 'INVALID_RESPONSE');
    return { items, nextPage: items.length === perPage ? page + 1 : null };
  }
  async source(address: RepositoryAddress, sha: string, path: string, maxBytes = 80_000): Promise<string> {
    if (!/^[a-f0-9]{40,64}$/i.test(sha) || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.') || path.includes('\\') || path.includes('\0')) throw new GitHubError('Invalid source path.', 400, 'INVALID_SOURCE_PATH');
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(address.owner)}/${encodeURIComponent(address.name)}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await this.fetcher(url, { signal: this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new GitHubError('Source content is unavailable at this snapshot.', response.status, 'SOURCE_UNAVAILABLE');
    return boundedText(response, maxBytes);
  }
}

export function clearGitHubCacheForTests() { cache.clear(); pending.clear(); }
