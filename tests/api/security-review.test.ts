import { afterAll, beforeAll, expect, test } from 'vitest';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { demoSnapshot } from '@patchwork/fixtures';
import { validateGraphSnapshot, GitHubWebUrlSchema } from '@patchwork/contracts';
import { createApplicationServer } from '../../apps/web/server';
import { FileInspector } from '../../apps/web/src/components/FileInspector';

const privateText = 'PRIVATE_SOURCE_SENTINEL github_pat_AAAAAAAAAAAAAAAAAAAAAAAA https://private-user:private-password@example.test/source';
let server: Server, base: string;
beforeAll(async () => {
  server = await createApplicationServer({ production: true, auth: null, runAnalysis: async () => { throw Object.assign(new Error(privateText), { code: privateText }); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

test('HTTP and stored job diagnostics do not echo private exception text or unknown code', async () => {
  const created = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: 'acme/private' }) });
  expect(created.status).toBe(202); const { jobId } = await created.json();
  let job: { status: string } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/api/jobs/${jobId}`); const text = await response.text();
    expect(text).not.toMatch(/PRIVATE_SOURCE_SENTINEL|github_pat_|private-user|private-password|example\.test\/source/);
    job = JSON.parse(text); if (job!.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(job?.status).toBe('failed');
  const result = await fetch(base + '/api/grouping/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshotId: demoSnapshot.id, operation: { type: 'rename', groupId: privateText, label: 'x' } }) });
  const text = await result.text(); expect(text).not.toContain(privateText);
});

test('static traversal is refused and production responses carry a restrictive content policy', async () => {
  const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(base + '/%2e%2e%2f.env', incoming => { const chunks: Buffer[] = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('end', () => resolve({ status: incoming.statusCode!, text: Buffer.concat(chunks).toString() })); });
    req.on('error', reject); req.end();
  });
  expect(response.status).toBe(403); expect(response.text).not.toMatch(/DATABASE_URL|OPENAI_API_KEY/);
  const health = await fetch(base + '/api/health');
  expect(health.headers.get('content-security-policy')).toContain("connect-src 'self'");
});

test('canonical external links reject executable, credentialed and lookalike destinations', () => {
  for (const link of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://github.com.evil.test/acme/repo', 'https://user:password@github.com/acme/repo', 'http://github.com/acme/repo', 'not a URL']) {
    expect(GitHubWebUrlSchema.safeParse(link).success).toBe(false);
    const snapshot = structuredClone(demoSnapshot); snapshot.sources[0]!.url = link;
    expect(() => validateGraphSnapshot(snapshot)).toThrow();
  }
  expect(GitHubWebUrlSchema.safeParse('https://github.com/acme/repo/pull/1').success).toBe(true);
});

test('hostile repository labels are rendered as text; inspector links use the fixed GitHub origin', () => {
  const snapshot = structuredClone(demoSnapshot), file = snapshot.nodes[0]!;
  const payload = '<img src=x onerror="alert(1)"><script>fetch("https://evil.test")</script>';
  file.path = 'src/' + payload + '.ts'; snapshot.groups.find(group => group.id === file.groupId)!.label = payload;
  const source = snapshot.sources[0]!; source.title = payload; source.files = [{ fileId: file.id, path: file.path, status: 'modified', additions: 1, deletions: 1 }];
  const html = renderToStaticMarkup(createElement(FileInspector, { snapshot, file, selectedSources: [source], closeRef: null, onClose() {}, onBack() {}, onSelectFile() {}, onFocusGroup() {}, organizeControls: null }));
  expect(html).toContain('&lt;img'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('href="https://evil.test');
});
