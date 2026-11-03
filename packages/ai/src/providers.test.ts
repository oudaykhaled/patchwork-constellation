import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideMembership, generateLabels, TypeSafeDecisionProvider, validateDecisionResponse, type DecisionQuestion, type RequestBudget } from './providers';

const questions = {
  owner: { type: 'choice', instructions: 'Choose a known owner.', criteria: { auth: 'Authentication', uncertain: 'Insufficient evidence' } },
  size: { type: 'score', instructions: 'Rate module breadth.', criteria: ['One file', 'Several files', 'Many files'] },
  grounded: { type: 'noul', instructions: 'Is the proposed relation supported?' },
} satisfies Record<string, DecisionQuestion>;
const valid = () => ({
  model: 'jev-1.14.0',
  answers: {
    owner: { type: 'choice', choice: 'auth', confidence: 0.8, probabilities: { auth: 0.9, uncertain: 0.1 } },
    size: { type: 'score', score: 1.4, confidence: 0.3, legend: { 0: 'One file', 1: 'Several files', 2: 'Many files' }, probabilities: { 0: 0, 1: 0.6, 2: 0.4 } },
    grounded: { type: 'noul', noul: 0.98 },
  }, usage: { input_tokens: 100, output_tokens: 20 },
});
const evidence = {
  files: [{ id: 'f', path: 'src/auth.ts', groupId: 'auth', evidenceId: 'file:f', imports: [] }],
  groups: [{ id: 'auth', label: 'Auth', paths: ['src/auth.ts'] }], allowedEvidenceIds: ['file:f'],
};
function budget(fetcher: typeof fetch, overrides: Partial<RequestBudget> = {}): RequestBudget {
  return { fetch: fetcher, timeoutMs: 500, requests: 0, maxRequests: 3, maxInputCharacters: 6000, reserveRequest() {}, ...overrides };
}
afterEach(() => vi.unstubAllGlobals());

describe('System One primitive contracts', () => {
  it('keeps Choice, Score and Noul shapes distinct and records the actual model', () => {
    const result = validateDecisionResponse(valid(), questions, 'jev-1.14.0');
    expect(result.answers.owner.choice).toBe('auth');
    expect(result.answers.size.score).toBe(1.4);
    expect(result.answers.grounded).toEqual({ type: 'noul', noul: 0.98 });
    expect(result.model).toBe('jev-1.14.0');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });
  it('preserves absent confidence instead of manufacturing certainty', () => {
    const response: ReturnType<typeof valid> = valid();
    delete (response.answers.owner as { confidence?: number }).confidence;
    delete (response.answers.size as { confidence?: number }).confidence;
    const result = validateDecisionResponse(response, questions, 'jev-1.14.0');
    expect(result.answers.owner).not.toHaveProperty('confidence');
    expect(result.answers.size).not.toHaveProperty('confidence');
  });
  it.each([
    ['unknown candidate', (response: ReturnType<typeof valid>) => { response.answers.owner.choice = 'invented'; }],
    ['foreign probability', (response: ReturnType<typeof valid>) => { Object.assign(response.answers.owner, { probabilities: { auth: 0.5, invented: 0.5 } }); }],
    ['non-normalized probabilities', (response: ReturnType<typeof valid>) => { response.answers.owner.probabilities.auth = 0.5; }],
    ['contradictory choice', (response: ReturnType<typeof valid>) => { response.answers.owner.choice = 'uncertain'; }],
    ['invalid confidence', (response: ReturnType<typeof valid>) => { response.answers.owner.confidence = Number.NaN; }],
    ['contradictory score', (response: ReturnType<typeof valid>) => { response.answers.size.score = 0; }],
    ['foreign legend', (response: ReturnType<typeof valid>) => { response.answers.size.legend[1] = 'New level'; }],
    ['noul range', (response: ReturnType<typeof valid>) => { response.answers.grounded.noul = -1; }],
    ['primitive confusion', (response: ReturnType<typeof valid>) => { (response.answers.grounded as { type: string }).type = 'score'; }],
    ['unexpected answer', (response: ReturnType<typeof valid>) => { Object.assign(response.answers, { invented: { type: 'noul', noul: 1 } }); }],
    ['model drift', (response: ReturnType<typeof valid>) => { response.model = 'jev-1.13.0'; }],
  ])('rejects %s', (_name, mutate) => {
    const response = valid(); mutate(response);
    expect(() => validateDecisionResponse(response, questions, 'jev-1.14.0')).toThrow();
  });
  it('uses fixed System One routes, retains discovery metadata and accepts pinned versions absent from alias lists', async () => {
    const transport = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/models')
      ? Response.json({ models: [{ name: 'jev-latest', description: 'Current stable', release_date: '2026-10-14' }] })
      : Response.json(valid()));
    const provider = new TypeSafeDecisionProvider({ apiKey: 'test-only', model: 'jev-1.14.0' });
    expect(await provider.discover(budget(transport))).toEqual([{ name: 'jev-latest', description: 'Current stable', releaseDate: '2026-10-14' }]);
    expect((await provider.decide({ synthetic: true }, questions, budget(transport))).model).toBe('jev-1.14.0');
    expect(transport.mock.calls.map(call => call[0])).toEqual(['https://api.typesafe.ai/v1/models', 'https://api.typesafe.ai/v1/systemone']);
  });
  it('rejects malformed discovery and unknown aliases', async () => {
    for (const response of [{ models: [{ name: '' }] }, { models: [{ name: 'jev-latest' }, { name: 'jev-latest' }] }, { models: [{ name: 'another' }] }]) {
      const provider = new TypeSafeDecisionProvider({ apiKey: 'test-only', model: 'jev-custom' });
      await expect(provider.discover(budget(async () => Response.json(response)))).rejects.toBeDefined();
    }
  });
  it('rejects malformed question limits before transmission', async () => {
    const transport = vi.fn(async () => Response.json(valid()));
    const provider = new TypeSafeDecisionProvider({ apiKey: 'test-only', model: 'jev-1.14.0' });
    await expect(provider.decide({}, { score: { type: 'score', instructions: 'Rate', criteria: ['One'] } }, budget(transport))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(provider.decide({}, {}, budget(transport))).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429])('returns a redacted %i failure without leaking body or credentials', async status => {
    const transport = vi.fn(async () => new Response('secret-body-key', { status, headers: { 'retry-after': '60' } }));
    const provider = new TypeSafeDecisionProvider({ apiKey: 'secret-key', model: 'jev-1.14.0' });
    const error = await provider.discover(budget(transport)).catch(error => error);
    expect(error.code).toBe(status === 429 ? 'RATE_LIMITED' : 'PROVIDER_AUTH');
    expect(String(error)).not.toContain('secret');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('reports timeout and cancellation with no automatic paid retry', async () => {
    const transport = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('redacted', 'AbortError')), { once: true });
    }));
    const provider = new TypeSafeDecisionProvider({ apiKey: 'test-only', model: 'jev-1.14.0' });
    await expect(provider.discover(budget(transport, { timeoutMs: 5 }))).rejects.toMatchObject({ code: 'TIMEOUT' });
    const controller = new AbortController(); controller.abort();
    await expect(provider.discover(budget(transport, { signal: controller.signal }))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('keeps membership confidence absent and sends candidate evidence descriptions', async () => {
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.questions.f0.criteria.g0).toContain('file:f');
      expect(sent.state.candidates[0].rationale).toBe('Shared auth paths.');
      return Response.json({ model: 'jev-1.14.0', answers: { f0: { type: 'choice', choice: 'g0', probabilities: { g0: 1, uncertain: 0 } } }, usage: { input_tokens: 10, output_tokens: 3 } });
    });
    const result = await decideMembership({ apiKey: 'test-only', model: 'jev-1.14.0' }, evidence, [{ groupId: 'auth', label: 'Auth', rationale: 'Shared auth paths.', evidenceIds: ['file:f'] }], budget(transport));
    expect(result.decisions[0]).toEqual({ fileId: 'f', groupId: 'auth' });
  });
  it('prevents provider execution in a browser and with an absent key', async () => {
    const transport = vi.fn(async () => Response.json(valid()));
    await expect(new TypeSafeDecisionProvider({ apiKey: '', model: 'jev-1.14.0' }).discover(budget(transport))).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
    vi.stubGlobal('window', {});
    await expect(new TypeSafeDecisionProvider({ apiKey: 'test-only', model: 'jev-1.14.0' }).discover(budget(transport))).rejects.toMatchObject({ code: 'SERVER_ONLY' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('independently bounds generative output before a request', async () => {
    const transport = vi.fn(async () => Response.json({}));
    await expect(generateLabels({ apiKey: 'test-only', model: 'pinned-generative', maxOutputTokens: 100_000 }, evidence, budget(transport))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(transport).not.toHaveBeenCalled();
  });
});
