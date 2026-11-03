import { createHash } from 'node:crypto';

/** Read-only GitHub gateway. Repository data never controls request origins. */
export class GitHubError extends Error {
  constructor(message: string, public status = 500, public code = 'GITHUB_ERROR', public retryAfter?: number) {
    super(message); this.name = 'GitHubError';
  }
}

/** Deliberately excludes URLs, repository paths, credentials, payloads and error text. */
export interface GitHubTelemetry {
  event: 'request' | 'cache-hit' | 'conditional-hit' | 'deduplicated' | 'retry' | 'coverage';
  resource: 'metadata' | 'tree' | 'blob' | 'source' | 'pulls' | 'commits' | 'comparison';
  status?: number;
  attempt?: number;
  waitMs?: number;
  remaining?: number;
  limit?: number;
  resetAt?: number;
  reason?: 'recursive-tree-truncated' | 'comparison-file-cap' | 'pull-file-cap';
}
export interface GitHubOptions {
  token?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  onTelemetry?: (event: GitHubTelemetry) => void;
  /** Retry budgets never shorten a GitHub requested wait: longer waits return retry guidance. */
  maxRetries?: number;
  maxRetryWaitMs?: number;
  cacheTtlMs?: number;
}
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

interface CacheEntry { value: unknown; etag?: string; link?: string; expires: number; immutable?: boolean; }
interface PendingEntry { promise: Promise<CacheEntry>; controller: AbortController; subscribers: number; }
interface QueueWaiter { resolve: (release: () => void) => void; reject: (reason: unknown) => void; signal: AbortSignal; abort: () => void; }
interface RequestQueue { active: boolean; waiting: QueueWaiter[]; }
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, PendingEntry>();
const queues = new Map<string, RequestQueue>();
const API_VERSION = '2022-11-28';
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 300;
const MAX_PENDING_REQUESTS = 64;

function abortReason(signal: AbortSignal) { return signal.reason ?? new DOMException('Request canceled.', 'AbortError'); }
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(abortReason(signal)); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function acquire(scope: string, signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  const queue = queues.get(scope) ?? { active: false, waiting: [] };
  queues.set(scope, queue);
  const release = () => {
    const next = queue.waiting.shift();
    if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(release); }
    else { queue.active = false; if (queues.get(scope) === queue) queues.delete(scope); }
  };
  if (!queue.active) { queue.active = true; return Promise.resolve(release); }
  if (queue.waiting.length >= MAX_PENDING_REQUESTS) return Promise.reject(new GitHubError('GitHub request queue is full. Retry shortly.', 429, 'QUEUE_FULL', 1));
  return new Promise((resolve, reject) => {
    const waiter: QueueWaiter = { resolve, reject, signal, abort: () => { const index = queue.waiting.indexOf(waiter); if (index >= 0) queue.waiting.splice(index, 1); reject(abortReason(signal)); } };
    queue.waiting.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
  });
}
async function boundedText(response: Response, max: number): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > max) { await response.body?.cancel(); throw new GitHubError('GitHub response exceeds the configured size limit.', 413, 'RESPONSE_LIMIT'); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new GitHubError('GitHub response exceeds the configured size limit.', 413, 'RESPONSE_LIMIT'); }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(all);
}
function numberHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name); if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw); return Number.isFinite(value) && value >= 0 ? value : undefined;
}
function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(value, maximum)) : fallback;
}
function requestedWait(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(header); if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = numberHeader(response.headers, 'x-ratelimit-reset');
    if (reset !== undefined) return Math.max(1_000, reset * 1_000 - Date.now());
  }
  return undefined;
}
function resourceFor(url: URL, raw: boolean): GitHubTelemetry['resource'] {
  if (raw) return 'source';
  const part = url.pathname.split('/')[4];
  if (part === 'compare') return 'comparison';
  if (part === 'pulls' || part === 'commits') return part;
  if (part === 'git') return url.pathname.split('/')[5] === 'trees' ? 'tree' : 'blob';
  return 'metadata';
}

export class GitHubClient {
  private fetcher: typeof fetch;
  private token?: string;
  private scope: string;
  constructor(private options: GitHubOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.token = options.token ?? (typeof process !== 'undefined' ? process.env.GITHUB_TOKEN : undefined);
    this.scope = this.token ? `token:${createHash('sha256').update(this.token).digest('hex')}` : 'public';
  }
  private emit(event: GitHubTelemetry) {
    // Observability hooks cannot change ingestion or disclose exceptions to logs.
    try { this.options.onTelemetry?.(event); } catch { /* optional observer */ }
  }
  private apiUrl(path: string): URL {
    let decoded: string;
    try { decoded = decodeURIComponent(path.split('?')[0]!); } catch { throw new GitHubError('Invalid GitHub API path.', 400, 'INVALID_API_PATH'); }
    if (!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|\?|$)/.test(path) || decoded.split('/').some(segment => segment === '..' || segment === '.') || decoded.includes('\\') || /[\x00-\x1f\x7f]/.test(decoded) || path.includes('#')) throw new GitHubError('Invalid GitHub API path.', 400, 'INVALID_API_PATH');
    const url = new URL(path, 'https://api.github.com');
    if (url.origin !== 'https://api.github.com') throw new GitHubError('Invalid API origin.', 400, 'INVALID_API_PATH');
    return url;
  }
  private async subscribe(entry: PendingEntry): Promise<CacheEntry> {
    const signal = this.options.signal; signal?.throwIfAborted(); entry.subscribers++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return; settled = true; signal?.removeEventListener('abort', abort); entry.subscribers--;
        if (entry.subscribers === 0) entry.controller.abort(new DOMException('No request subscribers remain.', 'AbortError'));
        fn();
      };
      const abort = () => finish(() => reject(abortReason(signal!)));
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
  }
  private async request(url: URL, immutable: boolean, raw = false, maxBytes = MAX_RESPONSE_BYTES): Promise<CacheEntry> {
    this.options.signal?.throwIfAborted();
    const key = `${this.scope}:${raw ? `raw:${maxBytes}:` : ''}${url.href}`;
    const resource = resourceFor(url, raw); const old = cache.get(key);
    if (old && old.expires > Date.now()) { this.emit({ event: 'cache-hit', resource }); return structuredClone(old); }
    const shared = pending.get(key);
    if (shared && !shared.controller.signal.aborted) { this.emit({ event: 'deduplicated', resource }); return structuredClone(await this.subscribe(shared)); }
    if (pending.size >= MAX_PENDING_REQUESTS) throw new GitHubError('GitHub request queue is full. Retry shortly.', 429, 'QUEUE_FULL', 1);
    const controller = new AbortController();
    const entry: PendingEntry = { controller, subscribers: 0, promise: Promise.resolve(undefined as never) };
    entry.promise = this.execute(url, old, immutable, raw, maxBytes, resource, controller.signal).then(result => {
      controller.signal.throwIfAborted();
      if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) cache.delete(cache.keys().next().value!);
      cache.set(key, result); return result;
    }).finally(() => { if (pending.get(key) === entry) pending.delete(key); });
    pending.set(key, entry);
    return structuredClone(await this.subscribe(entry));
  }
  private async execute(url: URL, old: CacheEntry | undefined, immutable: boolean, raw: boolean, maxBytes: number, resource: GitHubTelemetry['resource'], signal: AbortSignal): Promise<CacheEntry> {
    const release = await acquire(this.scope, signal);
    const maxRetries = Math.trunc(boundedOption(this.options.maxRetries, 2, 3));
    const waitBudget = boundedOption(this.options.maxRetryWaitMs, 5_000, 30_000);
    let waited = 0;
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const headers: Record<string, string> = raw ? {} : { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'Patchwork-Constellation' };
        if (!raw && this.token) headers.Authorization = `Bearer ${this.token}`;
        if (old?.etag) headers['If-None-Match'] = old.etag;
        let response: Response;
        try { response = await this.fetcher(url.href, { ...(Object.keys(headers).length ? { headers } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error' }); }
        catch {
          signal.throwIfAborted();
          this.emit({ event: 'request', resource, attempt });
          const waitMs = 250 * 2 ** attempt;
          if (attempt >= maxRetries || waited + waitMs > waitBudget) throw new GitHubError('GitHub could not be reached. Retry the analysis.', 502, 'NETWORK_ERROR');
          this.emit({ event: 'retry', resource, attempt, waitMs }); waited += waitMs; await sleep(waitMs, signal); continue;
        }
        this.emit({ event: 'request', resource, attempt, status: response.status, remaining: numberHeader(response.headers, 'x-ratelimit-remaining'), limit: numberHeader(response.headers, 'x-ratelimit-limit'), resetAt: numberHeader(response.headers, 'x-ratelimit-reset') });
        const ttl = immutable ? 15 * 60_000 : boundedOption(this.options.cacheTtlMs, 60_000, 60_000);
        if (response.status === 304 && old) { this.emit({ event: 'conditional-hit', resource, status: 304 }); return { ...old, expires: Date.now() + ttl }; }
        if (!response.ok) {
          const requested = requestedWait(response);
          // A secondary rate limit may be a 403 without quota headers. Its message is used
          // only for classification and is never copied into telemetry/errors.
          let secondaryRate = false;
          if (response.status === 403 && requested === undefined) {
            try { secondaryRate = /(?:secondary\s+)?rate\s+limit/i.test(await boundedText(response, 4_096)); } catch { /* generic access denial */ }
          }
          const isRateLimit = response.status === 429 || (response.status === 403 && (secondaryRate || requested !== undefined || response.headers.get('x-ratelimit-remaining') === '0'));
          const retryable = isRateLimit || [500, 502, 503, 504].includes(response.status);
          const waitMs = requested ?? (isRateLimit ? 60_000 * 2 ** attempt : 250 * 2 ** attempt);
          if (!response.bodyUsed) await response.body?.cancel();
          if (retryable && attempt < maxRetries && waited + waitMs <= waitBudget) {
            this.emit({ event: 'retry', resource, attempt, waitMs, status: response.status }); waited += waitMs; await sleep(waitMs, signal); continue;
          }
          if (isRateLimit) throw new GitHubError('GitHub is limiting requests. Retry after the indicated delay.', response.status, 'RATE_LIMITED', Math.ceil(waitMs / 1_000));
          if (response.status === 403) throw new GitHubError('The repository or revision is not authorized for this credential.', 403, 'ACCESS_DENIED');
          if (response.status === 404) throw new GitHubError('Repository or revision not found. Check its name and access.', 404, 'NOT_FOUND');
          if (response.status === 401) throw new GitHubError('The server GitHub credential is invalid or expired.', 401, 'AUTH_FAILED');
          throw new GitHubError(raw ? 'Source content is unavailable at this snapshot.' : `GitHub returned ${response.status}. Retry the analysis.`, response.status, raw ? 'SOURCE_UNAVAILABLE' : 'GITHUB_ERROR');
        }
        let value: unknown;
        let text: string;
        try { text = await boundedText(response, maxBytes); }
        catch (error) {
          signal.throwIfAborted();
          if (error instanceof GitHubError) throw error;
          throw new GitHubError('GitHub response was interrupted. Retry the analysis.', 502, 'NETWORK_ERROR');
        }
        try { value = raw ? text : JSON.parse(text); } catch { throw new GitHubError('GitHub returned an invalid response.', 502, 'INVALID_RESPONSE'); }
        if (!raw && typeof value === 'object' && value !== null) {
          const payload = value as { truncated?: boolean; files?: unknown[] };
          if (resource === 'tree' && payload.truncated) this.emit({ event: 'coverage', resource, reason: 'recursive-tree-truncated' });
          if (resource === 'comparison' && (payload.files?.length ?? 0) >= 300) this.emit({ event: 'coverage', resource, reason: 'comparison-file-cap' });
          if (resource === 'pulls' && Array.isArray(value) && url.pathname.endsWith('/files') && Number(url.searchParams.get('page')) >= 30 && value.length >= 100) this.emit({ event: 'coverage', resource, reason: 'pull-file-cap' });
        }
        return { value, etag: response.headers.get('etag') ?? undefined, link: response.headers.get('link') ?? undefined, expires: Date.now() + ttl, immutable };
      }
    } finally { release(); }
  }
  async get<T>(path: string, immutable = false): Promise<T> { return (await this.request(this.apiUrl(path), immutable)).value as T; }
  async page<T>(path: string, page = 1, perPage = 30): Promise<GitHubPage<T>> {
    if (!Number.isInteger(page) || page < 1 || page > 100 || !Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new GitHubError('Invalid pagination.', 400, 'INVALID_PAGINATION');
    const url = this.apiUrl(path); url.searchParams.set('per_page', String(perPage)); url.searchParams.set('page', String(page));
    const result = await this.request(url, false); const items = result.value;
    if (!Array.isArray(items)) throw new GitHubError('GitHub returned an invalid list.', 502, 'INVALID_RESPONSE');
    // A Link header is authoritative. Never fetch a URL supplied by GitHub; retain our origin/path.
    const hasNext = result.link !== undefined ? /;\s*rel="next"/.test(result.link) : items.length === perPage;
    return { items: items as T[], nextPage: hasNext && page < 100 ? page + 1 : null };
  }
  async source(address: RepositoryAddress, sha: string, path: string, maxBytes = 80_000): Promise<string> {
    // Revalidate address even when a caller supplies a structural object instead of parseRepository().
    const safe = parseRepository(`${address.owner}/${address.name}`);
    if (!/^[a-f0-9]{40,64}$/i.test(sha) || !path || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES) throw new GitHubError('Invalid source path or size limit.', 400, 'INVALID_SOURCE_PATH');
    const url = new URL(`https://raw.githubusercontent.com/${encodeURIComponent(safe.owner)}/${encodeURIComponent(safe.name)}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`);
    return (await this.request(url, true, true, maxBytes)).value as string;
  }
}

export function clearGitHubCacheForTests() {
  for (const entry of pending.values()) entry.controller.abort();
  cache.clear(); pending.clear();
}

/** Webhooks expire mutable metadata; existing immutable snapshot/tree/blob entries survive. */
export function invalidateGitHubRepositoryCache(repository: string): number {
  const address = parseRepository(repository);
  const prefix = `https://api.github.com/repos/${address.owner}/${address.name}`.toLowerCase();
  let invalidated = 0;
  for (const [key, entry] of cache) {
    const urlStart = key.indexOf('https://');
    const href = key.slice(urlStart).toLowerCase();
    if (!entry.immutable && (href === prefix || href.startsWith(`${prefix}/`) || href.startsWith(`${prefix}?`))) { entry.expires = 0; invalidated++; }
  }
  return invalidated;
}
