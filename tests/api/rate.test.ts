import { expect, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApplicationServer } from '../../apps/web/server';

test('configured request quotas still enforce 429 and remain isolated per server', async () => {
  const previous = process.env.API_REQUESTS_PER_MINUTE;
  let server: Awaited<ReturnType<typeof createApplicationServer>> | undefined;
  let second: Awaited<ReturnType<typeof createApplicationServer>> | undefined;
  try {
    process.env.API_REQUESTS_PER_MINUTE = '1';
    server = await createApplicationServer({ production: true });
    second = await createApplicationServer({ production: true });
    const listen = async (instance: typeof server) => {
      await new Promise<void>(resolve => instance!.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(instance!.address() as AddressInfo).port}`;
    };
    const firstUrl = await listen(server), secondUrl = await listen(second);
    expect((await fetch(`${firstUrl}/api/health`)).status).toBe(200);
    const denied = await fetch(`${firstUrl}/api/health`);
    expect(denied.status).toBe(429);
    expect((await denied.json()).code).toBe('RATE_LIMITED');
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await fetch(`${secondUrl}/api/health`)).status).toBe(200);
  } finally {
    if (previous === undefined) delete process.env.API_REQUESTS_PER_MINUTE; else process.env.API_REQUESTS_PER_MINUTE = previous;
    for (const instance of [server, second]) if (instance) await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  }
});
