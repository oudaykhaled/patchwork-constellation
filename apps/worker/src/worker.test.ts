import { describe, expect, it } from 'vitest';
import { runAnalysisInWorker } from './index';
describe('analysis worker boundaries', () => {
  it('rejects invalid repository input in an isolated worker without outbound network', async () => {
    await expect(runAnalysisInWorker({ repository: 'https://evil.test/acme/tool' })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY', status: 400 });
  });
  it('honors cancellation before dispatch', async () => {
    const controller = new AbortController(); controller.abort();
    expect(() => runAnalysisInWorker({ repository: 'acme/tool' }, { signal: controller.signal })).toThrow();
  });
});
