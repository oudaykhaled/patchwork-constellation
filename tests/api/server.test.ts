import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApplicationServer } from '../../apps/web/server';

let server: Server;
let base: string;

beforeAll(async () => {
  server = await createApplicationServer({ production: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

describe('local HTTP trust boundaries', () => {
  test('health and config expose capabilities without credentials', async () => {
    const health = await fetch(base + '/api/health');
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe('ok');
    const response = await fetch(base + '/api/config');
    const config = await response.json();
    expect(config.github.publicRepositories).toBe(true);
    expect(config.github.privateRepositories).toBe(false);
    expect(config.deployment).toBe('local');
    const serialized = JSON.stringify(config);
    expect(serialized).not.toMatch(/(?:gh[pousr]_[a-zA-Z0-9]+|sk-[a-zA-Z0-9_-]+)/);
    expect(config).not.toHaveProperty('GITHUB_TOKEN');
    expect(config).not.toHaveProperty('OPENAI_API_KEY');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('rejects a non-local Host header', async () => {
    // Node fetch normalizes Host, so use the HTTP client to send the actual hostile header.
    const response = await new Promise<{ status: number; body: { code?: string } }>((resolve, reject) => {
      const outgoing = request(base + '/api/demo', { headers: { Host: 'attacker.example' } }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HOST_DENIED');
  });

  test('rejects cross-origin mutations before scheduling work', async () => {
    const response = await post('/api/analyze', { repository: 'octocat/Hello-World' }, { Origin: 'https://attacker.example' });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('ORIGIN_DENIED');
  });

  test('rejects unsupported and malformed bodies', async () => {
    const wrongType = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    expect(wrongType.status).toBe(415);
    const malformed = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
    const invalid = await post('/api/analyze', { repository: '' });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe('VALIDATION');
  });

  test('rejects oversized request bodies', async () => {
    const response = await post('/api/analyze', { repository: 'a'.repeat(128_001) });
    expect(response.status).toBe(413);
  });

  test('rejects unknown snapshots and source identifiers', async () => {
    const missing = await post('/api/sources', { snapshotId: 'does-not-exist', kind: 'pr', ids: ['pr-1'] });
    expect(missing.status).toBe(404);
    const snapshot = await (await fetch(base + '/api/demo')).json();
    const unknownSource = await post('/api/sources', { snapshotId: snapshot.id, kind: 'pr', ids: ['pr-does-not-exist'] });
    expect(unknownSource.status).toBe(400);
    const excessive = await post('/api/sources', { snapshotId: snapshot.id, kind: 'pr', ids: Array.from({ length: 21 }, (_, i) => `pr-${i}`) });
    expect(excessive.status).toBe(400);
    const grouping = await post('/api/grouping', { snapshotId: 'does-not-exist', enabled: false });
    expect(grouping.status).toBe(404);
    const job = await fetch(base + '/api/jobs/does-not-exist');
    expect(job.status).toBe(404);
  });

  test('demo reload and undo expose the same accepted grouping revision', async () => {
    const snapshot = await (await fetch(base + '/api/demo')).json();
    const original = snapshot.groups[0];
    const label = `Quality review ${Date.now()}`;
    const rename = await post('/api/grouping/mutate', {
      snapshotId: snapshot.id,
      operation: { type: 'rename', groupId: original.id, label },
    });
    expect(rename.status).toBe(200);
    const reloaded = await (await fetch(base + '/api/demo')).json();
    expect(reloaded.groups.find((group: { id: string }) => group.id === original.id).label).toBe(label);
    const undo = await post('/api/grouping/undo', { snapshotId: reloaded.id });
    expect(undo.status).toBe(200);
    const restored = await (await fetch(base + '/api/demo')).json();
    expect(restored.groups.find((group: { id: string }) => group.id === original.id).label).toBe(original.label);
  });

  test('progressive metadata, chunks and file details enforce snapshot scope independently', async () => {
    const snapshot = await (await fetch(base + '/api/demo')).json();
    const metadata = await (await fetch(`${base}/api/graphs/${encodeURIComponent(snapshot.id)}`)).json();
    expect(metadata.counts.files).toBe(212); expect(metadata.groups).toHaveLength(6); expect(metadata).not.toHaveProperty('nodes');
    const first = await (await fetch(`${base}${metadata.links.nodes}&limit=100`)).json();
    expect(first.items).toHaveLength(100); expect(first.nextCursor).toBeTruthy();
    const rest = await (await fetch(`${base}${metadata.links.nodes}&limit=100&cursor=${first.nextCursor}`)).json();
    expect(rest.items).toHaveLength(100); expect(rest.version).toBe(metadata.version);
    const file = await (await fetch(`${base}/api/files/${encodeURIComponent(snapshot.id)}/${encodeURIComponent(snapshot.nodes[0].id)}`)).json();
    expect(file.file.id).toBe(snapshot.nodes[0].id);
    for (const route of [`/api/graphs/${encodeURIComponent(snapshot.id)}`, `/api/files/${encodeURIComponent(snapshot.id)}/${encodeURIComponent(snapshot.nodes[0].id)}`]) {
      expect((await fetch(base + route + '?repository=wrong/repository')).status).toBe(404);
    }
    expect((await fetch(`${base}/api/graphs/${encodeURIComponent(snapshot.id)}/chunks?version=obsolete`)).status).toBe(409);
    expect((await fetch(`${base}/api/graphs/${encodeURIComponent(snapshot.id)}/chunks?limit=10000`)).status).toBe(400);
  });
});
