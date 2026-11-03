import { describe, expect, it, vi } from 'vitest';
import { runProviderSmoke } from './provider-smoke';

const env = { TYPESAFE_API_KEY: 'do-not-print-typesafe-key', OPENAI_API_KEY: 'do-not-print-openai-key', JEV_MODEL: 'jev-1.14.0', OPENAI_MODEL: 'generative-2026-11-01' };
const args = ['--live', '--reviewed-data-terms', '--reviewed-account-limits'];
describe('redacted opt-in provider smoke', () => {
  it('makes no calls without every explicit gate, even with configured keys', async () => {
    const transport = vi.fn(async () => Response.json({}));
    for (const flags of [[], ['--live'], args.slice(0, 2)]) expect((await runProviderSmoke({ args: flags, env, fetch: transport })).status).toBe('blocked');
    expect((await runProviderSmoke({ args, env: { ...env, JEV_MODEL: 'jev-latest' }, fetch: transport })).status).toBe('blocked');
    expect((await runProviderSmoke({ args, env: { ...env, OPENAI_API_KEY: '' }, fetch: transport })).status).toBe('blocked');
    expect(transport).not.toHaveBeenCalled();
  });
  it('uses three bounded calls and outputs metadata rather than secrets or raw answers', async () => {
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/models')) return Response.json({ models: [{ name: 'jev-latest' }] });
      const request = JSON.parse(String(init?.body));
      expect(String(init?.body).length).toBeLessThanOrEqual(6000);
      if (String(url).endsWith('/responses')) {
        expect(request.max_output_tokens).toBe(256);
        return Response.json({ status: 'completed', model: env.OPENAI_MODEL, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ groups: [{ groupId: 'synthetic-auth', label: 'Identity', rationale: 'Sample auth path.', evidenceIds: ['file:synthetic-file'] }] }) }] }], usage: { input_tokens: 10, output_tokens: 20 } });
      }
      return Response.json({ model: env.JEV_MODEL, answers: { membership: { type: 'choice', choice: 'auth', probabilities: { auth: 1, uncertain: 0 } }, breadth: { type: 'score', score: 0, legend: { 0: 'One file', 1: 'Several files' }, probabilities: { 0: 1, 1: 0 } }, supported: { type: 'noul', noul: 1 } }, usage: { input_tokens: 10, output_tokens: 5 } });
    });
    const result = await runProviderSmoke({ args, env, fetch: transport });
    expect(result.status).toBe('passed'); expect(transport).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toMatch(/do-not-print|sample\/auth|Identity|synthetic-file/);
    expect(result.qualityEvaluation).toBe('not-performed');
  });
  it('redacts transport failures and refuses a retry beyond the call cap', async () => {
    const transport = vi.fn(async () => new Response('provider-private-body', { status: 401 }));
    const result = await runProviderSmoke({ args, env, fetch: transport });
    expect(result.status).toBe('failed'); expect(result).toMatchObject({ code: 'PROVIDER_AUTH' });
    expect(JSON.stringify(result)).not.toMatch(/do-not-print|provider-private-body/);
  });
});
