import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_LIMIT_DEFAULTS, type LocalGitRegistry, type LocalRepository } from '@patchwork/analysis';
import { demoSnapshot } from '@patchwork/fixtures';
import { createApplicationServer } from '../../apps/web/server';
import { ConfigurationError } from '../../apps/web/environment';
import type { GitHubAppAuth } from '../../apps/web/github-auth';

// The registry is built in memory: these checks never reach a mirror or GitHub.
const local: LocalRepository = { fullName: 'local/app', owner: 'local', name: 'app', label: 'App', gitDir: '/nonexistent/app.git', defaultRef: 'main', include: [], exclude: [], limits: { ...LOCAL_LIMIT_DEFAULTS }, fingerprint: 'a'.repeat(20) };
const registry = (only: boolean): LocalGitRegistry => ({ only, limits: { ...LOCAL_LIMIT_DEFAULTS }, repositories: [local], get: name => name.toLowerCase() === local.fullName ? local : undefined });
const savedAi = process.env.AI_ENABLED;
const servers: Server[] = [];
afterEach(async () => {
  if (savedAi === undefined) delete process.env.AI_ENABLED; else process.env.AI_ENABLED = savedAi;
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
function call<T = Record<string, unknown>>(server: Server, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const port = (server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => { try { resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T }); } catch (error) { reject(error); } });
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

describe('local mode configuration guards', () => {
  it('refuses to start with AI grouping enabled, which could send local paths to a provider', async () => {
    process.env.AI_ENABLED = 'true';
    const failure = createApplicationServer({ production: true, localRegistry: registry(true) });
    await expect(failure).rejects.toBeInstanceOf(ConfigurationError);
    await expect(failure).rejects.toThrow('AI grouping must stay disabled (AI_ENABLED=false) while local repositories are configured.');
  });

  it('refuses to start with GitHub App sign-in', async () => {
    process.env.AI_ENABLED = 'false';
    const failure = createApplicationServer({ production: true, localRegistry: registry(true), auth: {} as GitHubAppAuth });
    await expect(failure).rejects.toBeInstanceOf(ConfigurationError);
    await expect(failure).rejects.toThrow('Local repositories cannot be combined with GitHub App sign-in.');
  });

  it('with LOCAL_REPOS_ONLY=false, sends GitHub ids to GitHub and keeps local ids on the mirror', async () => {
    process.env.AI_ENABLED = 'false';
    const resolveAnalysisInput = vi.fn(async (input: { repository: string; contextRef?: string }) => ({ repository: input.repository, contextRef: 'c'.repeat(40), displayContextRef: 'main', mode: 'pr' as const }));
    const runAnalysis = vi.fn(async () => structuredClone(demoSnapshot));
    const server = await createApplicationServer({ production: true, localRegistry: registry(false), resolveAnalysisInput, runAnalysis });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const config = await call<{ github: { publicRepositories: boolean }; local: { enabled: boolean; only: boolean } }>(server, 'GET', '/api/config');
    expect(config.body.github.publicRepositories).toBe(true);
    expect(config.body.local).toMatchObject({ enabled: true, only: false });
    const github = await call(server, 'POST', '/api/analyze', { repository: 'acme/app' });
    expect(github.status).toBe(202);
    expect(resolveAnalysisInput).toHaveBeenCalledTimes(1);
    expect(resolveAnalysisInput.mock.calls[0]![0]).toMatchObject({ repository: 'acme/app' });
    await vi.waitFor(() => expect(runAnalysis).toHaveBeenCalledWith(expect.objectContaining({ repository: 'acme/app', contextRef: 'c'.repeat(40) }), expect.anything()));
    // A registered id is pinned from its mirror (absent here), never through the GitHub resolver.
    const registered = await call(server, 'POST', '/api/analyze', { repository: 'local/app' });
    expect(registered).toMatchObject({ status: 404, body: { code: 'LOCAL_REF' } });
    expect(resolveAnalysisInput).toHaveBeenCalledTimes(1);
  });
});
