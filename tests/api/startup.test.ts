import { expect, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApplicationServer, createStartupFailureServer } from '../../apps/web/server';
import { ConfigurationError } from '../../apps/web/environment';

async function withServer(server: Server, run: (base: string) => Promise<void>) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('actual analysis worker responds to a credential-free health probe', async () => {
  await withServer(await createApplicationServer({ production: true }), async base => {
    const responses = await Promise.all([fetch(base + '/api/health/worker'), fetch(base + '/api/health/worker')]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok', schemaVersion: '1' });
    }
  });
});

test('configuration failure has a visible recoverable page and failed health without raw service errors', async () => {
  await withServer(createStartupFailureServer(new Error('postgres://private-user:private-password@private-host')), async base => {
    const response = await fetch(base);
    const page = await response.text();
    expect(response.status).toBe(503);
    expect(page).toContain('Constellation needs configuration');
    expect(page).toContain('stop and restart');
    expect(page).not.toMatch(/private-user|private-password|private-host/);
    const health = await fetch(base + '/api/health');
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });
  await withServer(createStartupFailureServer(new ConfigurationError(['AI_ENABLED must be true or false.'])), async base => {
    expect(await (await fetch(base)).text()).toContain('AI_ENABLED must be true or false.');
  });
});
