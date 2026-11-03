import { describe, expect, it } from 'vitest';
import { createApiReplay, createApiScenarios } from './api-fixtures';

describe('authored GitHub HTTP replay corpus', () => {
  it('regenerates byte-stably with isolated copies and declares the required failure facts', () => {
    const expected = JSON.stringify(createApiScenarios());
    const first = createApiScenarios();
    first.pagination![0]!.status = 500;
    expect(JSON.stringify(createApiScenarios())).toBe(expected);
    const scenarios = createApiScenarios();
    expect(Object.keys(scenarios)).toEqual(['pagination', 'conditional', 'rateLimit', 'secondaryRateLimit', 'truncatedTree', 'cappedPullRequest', 'cappedComparison', 'permissionRevocation', 'removedRepository', 'disconnectedAccount', 'staleSelection']);
    expect(scenarios.cappedComparison![0]!.body).toMatchObject({ files: expect.any(Array) });
    expect((scenarios.cappedComparison![0]!.body as { files: unknown[] }).files).toHaveLength(300);
    expect(scenarios.cappedPullRequest![0]!.body).toMatchObject({ changed_files: 3001 });
  });

  it('replays pagination without live network fallback', async () => {
    const scenario = createApiScenarios().pagination!;
    const replay = createApiReplay(scenario);
    const first = await replay.fetch(`https://api.github.com${scenario[0]!.path}`);
    expect(await first.json()).toHaveLength(2);
    expect(first.headers.get('link')).toContain('rel="next"');
    const second = await replay.fetch(`https://api.github.com${scenario[1]!.path}`);
    expect(await second.json()).toHaveLength(1);
    expect(replay.remaining()).toBe(0);
    await expect(replay.fetch(`https://api.github.com${scenario[1]!.path}`)).rejects.toThrow('Unexpected synthetic API replay request');
  });

  it('preserves response codes and retry/cache headers', async () => {
    for (const scenario of Object.values(createApiScenarios())) {
      const replay = createApiReplay(scenario);
      for (const step of scenario) {
        const response = await replay.fetch(`https://api.github.com${step.path}`);
        expect(response.status).toBe(step.status);
        for (const [key, value] of Object.entries(step.headers ?? {})) expect(response.headers.get(key)).toBe(value);
        if (step.body !== undefined) expect(await response.json()).toEqual(step.body);
        else expect(await response.text()).toBe('');
      }
      expect(replay.remaining()).toBe(0);
    }
  });

  it('rejects foreign hosts, unexpected writes, and canceled reads before consuming a step', async () => {
    const step = createApiScenarios().pagination![0]!;
    const replay = createApiReplay([step]);
    await expect(replay.fetch(`https://example.invalid${step.path}`)).rejects.toThrow('Unexpected synthetic');
    await expect(replay.fetch(`https://api.github.com${step.path}`, { method: 'POST' })).rejects.toThrow('Unexpected synthetic');
    const controller = new AbortController();
    controller.abort();
    await expect(replay.fetch(`https://api.github.com${step.path}`, { signal: controller.signal })).rejects.toThrow();
    expect(replay.remaining()).toBe(1);
  });
});
