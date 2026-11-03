import { generateKeyPairSync } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, test } from 'vitest';
import { GitHubAppAuth, githubAuthConfig, type GitHubAuthConfig } from './github-auth';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const config: GitHubAuthConfig = { appId: '12', clientId: 'Iv1_test', clientSecret: 'synthetic-test-secret', privateKey, origin: 'https://constellation.example' };
const req = (cookie = '', headers: Record<string, string> = {}) => ({ headers: { cookie, ...headers } }) as IncomingMessage;
const res = () => { const headers: Record<string, string | string[]> = {}; return { headers, response: { setHeader: (name: string, value: string | string[]) => { headers[name] = value; } } as unknown as ServerResponse }; };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const repo = { id: 80, full_name: 'acme/private', private: true };
function fixture() {
  let now = Date.parse('2026-11-03T12:00:00Z'); let access = true; let revoked = false; let tokenCalls = 0;
  const requests: { url: string; body?: unknown; authorization?: string }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url); const authorization = new Headers(init?.headers).get('Authorization') ?? undefined;
    requests.push({ url: address, body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization });
    if (address === 'https://github.com/login/oauth/access_token') return json({ access_token: 'ghu_synthetic', token_type: 'bearer', expires_in: 28_800 });
    if (revoked && address.includes('/user')) return json({}, 401);
    if (address === 'https://api.github.com/user') return json({ id: 9, login: 'reviewer' });
    if (address.includes('/user/installations?')) return json({ installations: access ? [{ id: 18, suspended_at: null }] : [] });
    if (address.includes('/user/installations/18/repositories')) return json({ repositories: access ? [repo] : [] });
    if (address.endsWith('/app/installations/18/access_tokens')) { tokenCalls++; return json({ token: `ghs_synthetic_${tokenCalls}`, expires_at: new Date(now + 3_600_000).toISOString() }); }
    return json({}, 404);
  }) as typeof fetch;
  const auth = new GitHubAppAuth(config, { fetch: fetcher, now: () => now });
  return { auth, requests, get tokenCalls() { return tokenCalls; }, removeAccess: () => { access = false; }, revoke: () => { revoked = true; }, advance: (duration: number) => { now += duration; } };
}
async function login(auth: GitHubAppAuth) {
  const begun = res(); const url = new URL(auth.begin(begun.response));
  const cookie = String(begun.headers['Set-Cookie']).split(';')[0]!;
  const completed = res(); const session = await auth.complete(req(cookie), completed.response, 'synthetic-code', url.searchParams.get('state')!);
  const sessionCookie = (completed.headers['Set-Cookie'] as string[])[1]!.split(';')[0]!;
  return { session, cookie: sessionCookie, url, headers: completed.headers };
}

describe('GitHub App authorization boundary', () => {
  test('configuration is absent by default and fails closed for partial/insecure config', () => {
    expect(githubAuthConfig({})).toBeUndefined();
    expect(() => githubAuthConfig({ GITHUB_APP_ID: '12' })).toThrow('incomplete');
    expect(() => githubAuthConfig({ GITHUB_APP_ID: '12', GITHUB_APP_CLIENT_ID: 'id', GITHUB_APP_CLIENT_SECRET: 'secret', GITHUB_APP_PRIVATE_KEY: privateKey, APP_ORIGIN: 'http://evil.example' })).toThrow('HTTPS');
  });
  test('uses one-time browser-bound state and PKCE; rejects state tampering and replay', async () => {
    const { auth, requests } = fixture(); const begun = res(); const url = new URL(auth.begin(begun.response));
    expect(url.origin).toBe('https://github.com'); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;
    await expect(auth.complete(req('constellation_oauth=attacker'), res().response, 'code', state)).rejects.toMatchObject({ code: 'OAUTH_STATE' });
    await expect(auth.complete(req(String(begun.headers['Set-Cookie']).split(';')[0]), res().response, 'code', state)).rejects.toMatchObject({ code: 'OAUTH_STATE' });
    expect(requests).toHaveLength(0);
  });
  test('secure opaque sessions contain no user token and expire; CSRF protects disconnect', async () => {
    const f = fixture(); const { session, cookie, headers } = await login(f.auth);
    expect(JSON.stringify(session)).not.toContain('ghu_');
    expect((headers['Set-Cookie'] as string[])[1]).toContain('HttpOnly; SameSite=Lax');
    expect((headers['Set-Cookie'] as string[])[1]).toContain('; Secure');
    expect(f.auth.session(req(cookie))?.ownerId).toBe('github:9');
    expect(() => f.auth.disconnect(req(cookie), res().response)).toThrow();
    f.auth.disconnect(req(cookie, { origin: config.origin, 'x-csrf-token': session.csrf }), res().response);
    expect(f.auth.session(req(cookie))).toBeUndefined();
    const next = await login(f.auth); f.advance(28_800_001); expect(f.auth.session(req(next.cookie))).toBeUndefined();
  });
  test('repository discovery uses user+installation intersection; tampered installation denied', async () => {
    const f = fixture(); const { session } = await login(f.auth);
    expect(await f.auth.repositories(session)).toEqual([{ ...repo, installationId: 18 }]);
    await expect(f.auth.repositoryToken(session, repo.full_name, 999)).rejects.toMatchObject({ code: 'REPOSITORY_DENIED' });
    await expect(f.auth.repositoryToken(session, 'other/secret')).rejects.toMatchObject({ code: 'REPOSITORY_DENIED' });
    expect(f.tokenCalls).toBe(0);
  });
  test('token scope is one authorized repository with readonly permissions; reuse refreshes before expiry', async () => {
    const f = fixture(); const { session } = await login(f.auth);
    expect(await f.auth.repositoryToken(session, repo.full_name)).toBe('ghs_synthetic_1');
    expect(await f.auth.repositoryToken(session, repo.full_name)).toBe('ghs_synthetic_1');
    const mint = f.requests.find(request => request.url.endsWith('/access_tokens'))!;
    expect(mint.body).toEqual({ repository_ids: [80], permissions: { contents: 'read', pull_requests: 'read', metadata: 'read' } });
    expect(mint.authorization?.startsWith('Bearer ey')).toBe(true);
    f.advance(3_550_000); expect(await f.auth.repositoryToken(session, repo.full_name)).toBe('ghs_synthetic_2');
  });
  test('cached installation token never bypasses current user access, repository removal or revocation', async () => {
    const f = fixture(); const { session } = await login(f.auth); await f.auth.repositoryToken(session, repo.full_name);
    f.removeAccess(); await expect(f.auth.repositoryToken(session, repo.full_name)).rejects.toMatchObject({ code: 'REPOSITORY_DENIED' });
    expect(f.tokenCalls).toBe(1);
    const g = fixture(); const logged = await login(g.auth); await g.auth.repositoryToken(logged.session, repo.full_name); g.revoke();
    await expect(g.auth.repositoryToken(logged.session, repo.full_name)).rejects.toMatchObject({ code: 'AUTH_REVOKED' });
    expect(g.auth.session(req(logged.cookie))).toBeUndefined();
  });
  test('sessions cannot be forged from another service and revoked installation cache can be invalidated', async () => {
    const f = fixture(), g = fixture(); const { session } = await login(f.auth);
    await expect(g.auth.repositories(session)).rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED' });
    expect(f.auth.knownRepositoryScopes(18)).toEqual([]);
    await f.auth.repositoryToken(session, repo.full_name);
    expect(f.auth.knownRepositoryScopes(18, 80)).toEqual([{ ownerId: 'github:9', repository: 'acme/private' }]);
    expect(f.auth.knownRepositoryScopes(999)).toEqual([]);
    f.auth.invalidateRepository(18, 80); expect(f.auth.knownRepositoryScopes(18)).toEqual([]);
    await f.auth.repositoryToken(session, repo.full_name); expect(f.tokenCalls).toBe(2);
    f.auth.invalidateInstallation(18); expect(f.auth.knownRepositoryScopes(18)).toEqual([]);
  });
});
