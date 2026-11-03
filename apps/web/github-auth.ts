/** Server-only GitHub App authentication. No token or private key is serialized to a client. */
import { createHash, createPrivateKey, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

const API = 'https://api.github.com';
const VERSION = '2026-03-10';
const token = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.byteLength === right.byteLength && timingSafeEqual(left, right); };
const cookieValue = (req: IncomingMessage, name: string) => req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const positiveId = z.number().int().positive().safe();
async function boundedJson(response: Response, max: number): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > max) throw new AuthError('GitHub authorization response is too large.', 502, 'AUTH_RESPONSE_LIMIT');
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  if (reader) while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > max) { await reader.cancel(); throw new AuthError('GitHub authorization response is too large.', 502, 'AUTH_RESPONSE_LIMIT'); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString()) as unknown; } catch { throw new AuthError('GitHub returned invalid authorization data.', 502, 'INVALID_AUTH_RESPONSE'); }
}
const repositorySchema = z.object({ id: positiveId, full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/), private: z.boolean() });
export type AuthorizedRepository = z.infer<typeof repositorySchema> & { installationId: number };
export interface GitHubAuthConfig { appId: string; clientId: string; clientSecret: string; privateKey: string; origin: string; }
export interface GitHubSession { id: string; ownerId: string; login: string; csrf: string; expiresAt: number; }
type StoredSession = GitHubSession & { userToken: string };
export class AuthError extends Error {
  constructor(message: string, public status = 401, public code = 'SIGN_IN_REQUIRED') { super(message); this.name = 'AuthError'; }
}
export function githubAuthConfig(env: NodeJS.ProcessEnv = process.env): GitHubAuthConfig | undefined {
  const fields = ['GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'APP_ORIGIN'] as const;
  if (!fields.some(key => Boolean(env[key]?.trim()))) return undefined;
  if (fields.some(key => !env[key]?.trim())) throw new Error('GitHub App configuration is incomplete. Set every GitHub App setting and APP_ORIGIN.');
  const origin = new URL(env.APP_ORIGIN!);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('APP_ORIGIN must be an HTTPS origin (HTTP loopback is allowed for local development).');
  if (!/^\d+$/.test(env.GITHUB_APP_ID!)) throw new Error('GITHUB_APP_ID must be numeric.');
  const privateKey = env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n');
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('GitHub App requires an RSA private key of at least 2048 bits.');
  return { appId: env.GITHUB_APP_ID!, clientId: env.GITHUB_APP_CLIENT_ID!, clientSecret: env.GITHUB_APP_CLIENT_SECRET!, privateKey, origin: origin.origin };
}

export class GitHubAppAuth {
  private sessions = new Map<string, StoredSession>();
  private pending = new Map<string, { browser: string; verifier: string; expires: number }>();
  private installationTokens = new Map<string, { value: string; expires: number }>();
  private tokenRequests = new Map<string, Promise<string>>();
  private knownScopes = new Map<string, { installationId: number; repositoryId: number; ownerId: string; repository: string }>();
  private now: () => number;
  private fetcher: typeof fetch;
  constructor(readonly config: GitHubAuthConfig, options: { fetch?: typeof fetch; now?: () => number } = {}) { this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now; }
  private cookie(name: string, value: string, age: number) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${this.config.origin.startsWith('https:') ? '; Secure' : ''}`; }
  private sweep() {
    for (const [key, value] of this.pending) if (value.expires <= this.now()) this.pending.delete(key);
    for (const [key, value] of this.sessions) if (value.expiresAt <= this.now()) this.sessions.delete(key);
    for (const [key, value] of this.installationTokens) if (value.expires <= this.now()) this.installationTokens.delete(key);
  }
  begin(res: ServerResponse) {
    this.sweep();
    if (this.pending.size >= 256) throw new AuthError('Too many sign-in attempts. Retry shortly.', 429, 'AUTH_BUSY');
    const state = token(), browser = token(), verifier = token();
    this.pending.set(digest(state), { browser: digest(browser), verifier, expires: this.now() + 600_000 });
    res.setHeader('Set-Cookie', this.cookie('constellation_oauth', browser, 600));
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: `${this.config.origin}/api/auth/callback`, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return url.href;
  }
  private async request(path: string, credential: string, method = 'GET', payload?: unknown) {
    if (!/^\/(?:user(?:\/|$)|app\/installations\/\d+\/access_tokens$)/.test(path) || path.includes('..') || path.includes('\\') || path.includes('#')) throw new AuthError('Invalid authorization request.', 400, 'INVALID_AUTH_PATH');
    const response = await this.fetcher(API + path, { method, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': VERSION, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new AuthError(response.status === 401 ? 'GitHub authorization expired. Sign in again.' : response.status === 404 ? 'This installation or repository is no longer accessible. Reconnect it.' : response.status === 429 || response.status === 403 ? 'GitHub access was denied or rate limited. Reconnect or retry shortly.' : 'GitHub authorization is unavailable. Retry shortly.', response.status === 401 ? 401 : response.status === 404 ? 403 : 503, response.status === 401 ? 'AUTH_REVOKED' : response.status === 404 ? 'ACCESS_REMOVED' : 'AUTH_UNAVAILABLE');
    return boundedJson(response, 2_000_000);
  }
  async complete(req: IncomingMessage, res: ServerResponse, code: string, state: string) {
    const pending = this.pending.get(digest(state)); this.pending.delete(digest(state));
    const browser = cookieValue(req, 'constellation_oauth') ?? '';
    res.setHeader('Set-Cookie', this.cookie('constellation_oauth', '', 0));
    if (!pending || pending.expires <= this.now() || !equal(pending.browser, digest(browser)) || !code || code.length > 512) throw new AuthError('Sign-in expired or state did not match. Start sign-in again.', 400, 'OAUTH_STATE');
    const response = await this.fetcher('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code, redirect_uri: `${this.config.origin}/api/auth/callback`, code_verifier: pending.verifier }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new AuthError('GitHub sign-in failed. Start again.', 401, 'OAUTH_FAILED');
    // OAuth response is small; do not retain refresh tokens in this local/session-memory edition.
    const result = z.object({ access_token: z.string().min(1).max(4096), expires_in: z.number().positive().optional(), token_type: z.literal('bearer').optional() }).safeParse(await boundedJson(response, 16_384));
    if (!result.success) throw new AuthError('GitHub sign-in was declined. Start again.', 401, 'OAUTH_FAILED');
    const user = z.object({ id: positiveId, login: z.string().min(1).max(100) }).parse(await this.request('/user', result.data.access_token));
    this.sweep(); if (this.sessions.size >= 128) throw new AuthError('Session capacity reached. Retry later.', 503, 'AUTH_BUSY');
    const id = token(), csrf = token();
    const session: StoredSession = { id: digest(id), ownerId: `github:${user.id}`, login: user.login, csrf, userToken: result.data.access_token, expiresAt: this.now() + Math.min(result.data.expires_in ?? 28_800, 28_800) * 1000 };
    this.sessions.set(session.id, session);
    res.setHeader('Set-Cookie', [this.cookie('constellation_oauth', '', 0), this.cookie('constellation_session', id, Math.floor((session.expiresAt - this.now()) / 1000))]);
    return this.publicSession(session);
  }
  private publicSession(value: StoredSession): GitHubSession { const { userToken: _secret, ...session } = value; return session; }
  session(req: IncomingMessage): GitHubSession | undefined {
    this.sweep(); const value = this.sessions.get(digest(cookieValue(req, 'constellation_session') ?? '')); return value ? this.publicSession(value) : undefined;
  }
  requireSession(req: IncomingMessage): GitHubSession { const session = this.session(req); if (!session) throw new AuthError('Sign in with GitHub to access repository analysis.'); return session; }
  csrf(req: IncomingMessage, session: GitHubSession) { if (req.headers.origin !== this.config.origin || typeof req.headers['x-csrf-token'] !== 'string' || !equal(req.headers['x-csrf-token'], session.csrf)) throw new AuthError('Refresh the page and retry this action.', 403, 'CSRF_DENIED'); }
  disconnect(req: IncomingMessage, res: ServerResponse) {
    const session = this.requireSession(req); this.csrf(req, session);
    // Disconnect is account-wide: a second tab/session cannot restore deleted data.
    for (const [id, stored] of this.sessions) if (stored.ownerId === session.ownerId) this.sessions.delete(id);
    for (const [key, scope] of this.knownScopes) if (scope.ownerId === session.ownerId) this.knownScopes.delete(key);
    this.installationTokens.clear(); res.setHeader('Set-Cookie', this.cookie('constellation_session', '', 0));
  }
  private stored(session: GitHubSession) { const value = this.sessions.get(session.id); if (!value || value.expiresAt <= this.now()) throw new AuthError('GitHub session expired. Sign in again.'); return value; }
  /** Always live authorization: installation IDs, cached tokens and cached snapshots are not authority. */
  async repositories(session: GitHubSession): Promise<AuthorizedRepository[]> {
    const stored = this.stored(session); const repositories: AuthorizedRepository[] = [];
    let calls = 0;
    const discover = async (path: string) => { if (++calls > 100) throw new AuthError('Repository discovery limit reached. Narrow the App installation to selected repositories.', 422, 'AUTH_DISCOVERY_LIMIT'); return this.request(path, stored.userToken); };
    try {
      for (let page = 1; page <= 20; page++) {
        const result = z.object({ installations: z.array(z.object({ id: positiveId, suspended_at: z.string().nullable().optional() })) }).parse(await discover(`/user/installations?per_page=100&page=${page}`));
        for (const installation of result.installations) {
          if (installation.suspended_at) continue;
          for (let repoPage = 1; repoPage <= 20; repoPage++) {
            const result = z.object({ repositories: z.array(repositorySchema) }).parse(await discover(`/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`));
            repositories.push(...result.repositories.map(repository => ({ ...repository, installationId: installation.id })));
            if (repositories.length > 2_000) throw new AuthError('Repository discovery limit reached. Narrow the App installation to selected repositories.', 422, 'AUTH_DISCOVERY_LIMIT');
            if (result.repositories.length < 100) break;
            if (repoPage === 20) throw new AuthError('Repository discovery limit reached. Narrow the App installation to selected repositories.', 422, 'AUTH_DISCOVERY_LIMIT');
          }
        }
        if (result.installations.length < 100) break;
        if (page === 20) throw new AuthError('Installation discovery limit reached. Contact the maintainer.', 422, 'AUTH_DISCOVERY_LIMIT');
      }
    } catch (error) { if (error instanceof AuthError && error.code === 'AUTH_REVOKED') this.sessions.delete(session.id); throw error; }
    // A disconnect may have happened while upstream discovery was in flight.
    this.stored(session); return repositories;
  }
  async authorize(session: GitHubSession, repository: string, installationId?: number) {
    const found = (await this.repositories(session)).find(value => value.full_name.toLowerCase() === repository.toLowerCase() && (installationId === undefined || installationId === value.installationId));
    if (!found) throw new AuthError('Repository access was removed or this App is not installed for your account. Reconnect and select an accessible repository.', 403, 'REPOSITORY_DENIED');
    const key = `${found.installationId}:${found.id}:${session.ownerId}`;
    if (this.knownScopes.size >= 1_000 && !this.knownScopes.has(key)) this.knownScopes.delete(this.knownScopes.keys().next().value!);
    this.knownScopes.set(key, { installationId: found.installationId, repositoryId: found.id, ownerId: session.ownerId, repository: found.full_name.toLowerCase() });
    return found;
  }
  async repositoryToken(session: GitHubSession, repository: string, installationId?: number) {
    const authorized = await this.authorize(session, repository, installationId);
    const key = `${authorized.installationId}:${authorized.id}`; const cached = this.installationTokens.get(key);
    if (cached && cached.expires > this.now() + 60_000) return cached.value;
    const pending = this.tokenRequests.get(key); if (pending) { const value = await pending; this.stored(session); return value; }
    const work = (async () => {
      const seconds = Math.floor(this.now() / 1000); const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: this.config.appId })).toString('base64url');
      const content = `${header}.${payload}`; const jwt = `${content}.${sign('RSA-SHA256', Buffer.from(content), this.config.privateKey).toString('base64url')}`;
      const result = z.object({ token: z.string().min(1).max(16_384), expires_at: z.string().datetime() }).parse(await this.request(`/app/installations/${authorized.installationId}/access_tokens`, jwt, 'POST', { repository_ids: [authorized.id], permissions: { contents: 'read', pull_requests: 'read', metadata: 'read' } }));
      this.stored(session);
      const expires = Date.parse(result.expires_at);
      if (expires <= this.now() + 60_000 || expires > this.now() + 3_660_000) throw new AuthError('GitHub returned an invalid token expiry.', 502, 'INVALID_AUTH_RESPONSE');
      if (this.installationTokens.size >= 256) this.installationTokens.delete(this.installationTokens.keys().next().value!);
      this.installationTokens.set(key, { value: result.token, expires }); return result.token;
    })();
    this.tokenRequests.set(key, work); try { return await work; } finally { this.tokenRequests.delete(key); }
  }
  /** Worker recovery must obtain fresh authority, never deserialize a credential from a job. */
  async credentialsForOwner(ownerId: string, repository: string) {
    this.sweep();
    const session = [...this.sessions.values()].find(value => value.ownerId === ownerId);
    if (!session) throw new AuthError('Reconnect GitHub before retrying this stored analysis.', 403, 'AUTH_SESSION_REQUIRED');
    return { token: await this.repositoryToken(this.publicSession(session), repository), allowPrivate: true as const };
  }
  /** Webhook revocation can immediately expire tokens. Every read also checks live user access. */
  invalidateInstallation(id: number) { for (const key of this.installationTokens.keys()) if (key.startsWith(`${id}:`)) this.installationTokens.delete(key); for (const [key, scope] of this.knownScopes) if (scope.installationId === id) this.knownScopes.delete(key); }
  /** Routing hints only, populated by live authorization; never use as permission to read. Resolve BEFORE invalidating. */
  knownRepositoryScopes(installationId: number, repositoryId?: number) { return [...this.knownScopes.values()].filter(scope => scope.installationId === installationId && (repositoryId === undefined || scope.repositoryId === repositoryId)).map(({ ownerId, repository }) => ({ ownerId, repository })); }
  /** Numeric routing hints only. Call credentialsForOwner before any read or refresh. */
  knownRepositoryBindings(installationId?: number, repositoryId?: number) { return [...this.knownScopes.values()].filter(scope => (installationId === undefined || scope.installationId === installationId) && (repositoryId === undefined || scope.repositoryId === repositoryId)).map(scope => ({ ...scope })); }
  invalidateRepository(installationId: number, repositoryId: number) { this.installationTokens.delete(`${installationId}:${repositoryId}`); for (const [key, scope] of this.knownScopes) if (scope.installationId === installationId && scope.repositoryId === repositoryId) this.knownScopes.delete(key); }
}
