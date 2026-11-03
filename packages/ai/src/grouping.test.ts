import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphSnapshot } from '@patchwork/contracts';
import { GroupingService, validateCandidateLabels } from './index';

const snapshot = (): GraphSnapshot => ({
  schemaVersion: '1',
  id: 'snapshot-1', repository: { owner: 'example', name: 'repo', fullName: 'example/repo', defaultBranch: 'main', htmlUrl: 'https://github.com/example/repo' },
  contextRef: 'main', contextSha: '1234', createdAt: '2026-11-03T00:00:00Z', mode: 'demo', coverage: { status: 'complete', reasons: [] }, sources: [],
  groups: [{ id: 'auth', label: 'Auth', origin: 'rules' }, { id: 'billing', label: 'Billing', origin: 'rules' }],
  nodes: [
    { id: 'a', path: 'src/auth/session.ts', groupId: 'auth', sourceIds: [] },
    { id: 'b', path: 'src/auth/tokens.ts', groupId: 'auth', sourceIds: [] },
    { id: 'c', path: 'src/billing/charge.ts', groupId: 'billing', sourceIds: [] },
    { id: 'secret', path: '.env.production', groupId: 'auth', sourceIds: [] },
  ], edges: [{ id: 'e1', source: 'a', target: 'b', kind: 'import', evidence: { path: 'src/auth/session.ts', line: 1 } }],
});

type MockOptions = { confidence?: number; unknownId?: boolean; label?: string; discoveredModel?: string; responseModel?: string; moveToBilling?: boolean; status?: number };
function providerMock(options: MockOptions = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (options.status) return new Response('{}', { status: options.status });
    if (url.endsWith('/v1/models')) return Response.json({ models: [{ name: options.discoveredModel ?? 'test-jev' }] });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/v1/responses')) {
      const evidence = JSON.parse(body.input as string) as { groups: { id: string; label: string }[]; files: { evidenceId: string; groupId: string }[] };
      return Response.json({ status: 'completed', model: 'test-generative-2026', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ groups: evidence.groups.map(group => ({ groupId: options.unknownId ? 'invented' : group.id, label: options.label ?? `${group.label} module`, rationale: 'These paths share the same module prefix.', evidenceIds: [evidence.files.find(file => file.groupId === group.id)!.evidenceId] })) }) }] }], usage: { input_tokens: 100, output_tokens: 40 } });
    }
    if (url.endsWith('/v1/systemone')) {
      const questions = body.questions as Record<string, { criteria: Record<string, string> }>;
      const answers = Object.fromEntries(Object.entries(questions).map(([key, question]) => {
        const choice = options.moveToBilling ? 'g1' : 'g0';
        return [key, { type: 'choice', choice, confidence: options.confidence ?? 0.9, probabilities: Object.fromEntries(Object.keys(question.criteria).map(id => [id, id === choice ? 1 : 0])) }];
      }));
      return Response.json({ model: options.responseModel ?? 'test-jev-2026', answers, usage: { input_tokens: 150, output_tokens: 50 } });
    }
    throw new Error('Unexpected outbound destination');
  });
}
function configured(fetcher: ReturnType<typeof providerMock>, additional = {}) {
  return new GroupingService({ enabled: true, jevApiKey: 'test-only', jevModel: 'test-jev', generativeApiKey: 'test-only', generativeModel: 'test-generative', fetch: fetcher as typeof fetch, ...additional });
}

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('baseline and provider boundary', () => {
  it('makes no outbound calls when disabled, even if keys exist', async () => {
    const transport = providerMock();
    const service = configured(transport, { enabled: false });
    const before = snapshot();
    const result = await service.propose(before, { enabled: true });
    expect(result.status).toBe('baseline'); expect(result.origin).toBe('rules');
    expect(result.dataPolicy.fieldsSent).toEqual([]); expect(transport).not.toHaveBeenCalled();
    expect(result.membership.a).toBe('auth'); expect(before.nodes[0]!.groupId).toBe('auth');
  });
  it('requires explicit request, both keys and pinned model names', async () => {
    const transport = providerMock();
    expect((await configured(transport).propose(snapshot())).status).toBe('baseline');
    expect((await configured(transport, { jevModel: undefined }).propose(snapshot(), { enabled: true })).status).toBe('baseline');
    expect(transport).not.toHaveBeenCalled();
  });
  it('uses fixed endpoints, excludes secrets and validates live shapes', async () => {
    const transport = providerMock();
    const original = snapshot();
    const result = await configured(transport).propose(original, { enabled: true });
    expect(result.status).toBe('proposed'); expect(result.models).toEqual({ generative: 'test-generative-2026', jev: 'test-jev-2026' });
    expect(result.dataPolicy.excludedFiles).toBe(1); expect(result.dataPolicy.analyzedFiles).toBe(3);
    expect(transport.mock.calls.map(call => String(call[0]))).toEqual(['https://api.typesafe.ai/v1/models', 'https://api.openai.com/v1/responses', 'https://api.typesafe.ai/v1/systemone']);
    expect(JSON.stringify(transport.mock.calls)).not.toContain('.env.production');
    expect(original.groups[0]!.label).toBe('Auth'); expect(result.membership.secret).toBe('auth');
    const generated = JSON.parse(String(transport.mock.calls[1]![1]!.body));
    expect(generated.store).toBe(false); expect(generated.tools).toBeUndefined();
    expect(generated.text.format.type).toBe('json_schema'); expect(result.usage?.requests).toBe(3);
  });
  it('retains baseline on unavailable model, auth failure, and invalid IDs', async () => {
    for (const options of [{ discoveredModel: 'another-model' }, { status: 401 }, { unknownId: true }]) {
      const result = await configured(providerMock(options)).propose(snapshot(), { enabled: true });
      expect(result.status).toBe('baseline'); expect(result.membership.a).toBe('auth');
      expect(result.message).not.toContain('test-only');
    }
  });
  it('accepts a pinned Jev version when discovery lists aliases only', async () => {
    const transport = providerMock({ discoveredModel: 'jev-latest', responseModel: 'jev-1.14.0' });
    const result = await configured(transport, { jevModel: 'jev-1.14.0' }).propose(snapshot(), { enabled: true });
    expect(result.status).toBe('proposed');
    expect(result.models?.jev).toBe('jev-1.14.0');
    const request = JSON.parse(String(transport.mock.calls.find(call => String(call[0]).endsWith('/v1/systemone'))![1]!.body));
    expect(request.model).toBe('jev-1.14.0'); expect(transport).toHaveBeenCalledTimes(3);
  });
  it('rejects a response that differs from the pinned Jev version', async () => {
    const transport = providerMock({ discoveredModel: 'jev-latest', responseModel: 'jev-1.13.0' });
    const result = await configured(transport, { jevModel: 'jev-1.14.0' }).propose(snapshot(), { enabled: true });
    expect(result.status).toBe('baseline'); expect(result.message).toContain('pinned Jev version');
  });
  it('rejects arbitrary evidence IDs and markup rather than rendering them', () => {
    const evidence = { files: [{ id: 'a', path: 'a.ts', groupId: 'auth', evidenceId: 'file:a', imports: [] }], groups: [{ id: 'auth', label: 'Auth', paths: [] }], allowedEvidenceIds: ['file:a'] };
    expect(() => validateCandidateLabels({ groups: [{ groupId: 'auth', label: 'Auth', rationale: 'Evidence', evidenceIds: ['file:invented'] }] }, evidence)).toThrow('outside this snapshot');
    expect(() => validateCandidateLabels({ groups: [{ groupId: 'auth', label: '<script>bad</script>', rationale: 'Evidence', evidenceIds: ['file:a'] }] }, evidence)).toThrow('plain text');
  });
  it('retains membership on low model confidence', async () => {
    const result = await configured(providerMock({ confidence: 0.2, moveToBilling: true })).propose(snapshot(), { enabled: true });
    expect(result.status).toBe('proposed'); expect(result.membership.a).toBe('auth');
    expect(result.decisions[0]!.rationale).toContain('uncertain');
  });
  it('caches only within the same tenant, snapshot and grouping revision', async () => {
    const transport = providerMock(); const service = configured(transport);
    const first = await service.propose(snapshot(), { enabled: true, tenantId: 'alice' });
    const cached = await service.propose(snapshot(), { enabled: true, tenantId: 'alice' });
    expect(first.id).toBe(cached.id); expect(transport).toHaveBeenCalledTimes(3);
    await service.propose(snapshot(), { enabled: true, tenantId: 'bob' });
    expect(transport).toHaveBeenCalledTimes(6);
    service.mutate(snapshot(), { type: 'rename', groupId: 'auth', label: 'Authentication' }, { tenantId: 'alice' });
    await service.propose(snapshot(), { enabled: true, tenantId: 'alice' });
    expect(transport).toHaveBeenCalledTimes(9);
  });
  it('deduplicates simultaneous equivalent analyses', async () => {
    const transport = providerMock(); const service = configured(transport);
    const [left, right] = await Promise.all([service.propose(snapshot(), { enabled: true }), service.propose(snapshot(), { enabled: true })]);
    expect(left.id).toBe(right.id); expect(transport).toHaveBeenCalledTimes(3);
  });
  it('enforces a metadata and per-tenant call budget before sending', async () => {
    const transport = providerMock();
    const metadata = await configured(transport, { maxInputCharacters: 10 }).propose(snapshot(), { enabled: true });
    expect(metadata.status).toBe('baseline'); expect(transport).not.toHaveBeenCalled();
    const quota = await configured(transport, { maxRequestsPerTenant: 1 }).propose(snapshot(), { enabled: true });
    expect(quota.status).toBe('baseline'); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('handles cancellation without submitting any metadata', async () => {
    const transport = providerMock(); const controller = new AbortController(); controller.abort();
    const result = await configured(transport).propose(snapshot(), { enabled: true, signal: controller.signal });
    expect(result.status).toBe('baseline'); expect(result.message).toContain('cancelled'); expect(transport).not.toHaveBeenCalled();
  });
  it('does not retry before a long Retry-After date', async () => {
    const transport = vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': new Date(Date.now() + 60_000).toUTCString() } }));
    const result = await configured(transport as ReturnType<typeof providerMock>).propose(snapshot(), { enabled: true });
    expect(result.status).toBe('baseline'); expect(result.message).toContain('rate limited'); expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('revision and override invariants', () => {
  it('previews before apply, applies only for the same tenant and preserves facts', async () => {
    const service = configured(providerMock({ moveToBilling: true })); const original = snapshot();
    const proposal = await service.propose(original, { enabled: true, tenantId: 'alice' });
    expect(original.nodes[0]!.groupId).toBe('auth');
    expect(() => service.apply(original, proposal.id, { tenantId: 'bob' })).toThrow('unavailable');
    const result = service.apply(original, proposal.id, { tenantId: 'alice' });
    expect(result.snapshot.nodes[0]!.groupId).toBe('billing'); expect(result.snapshot.edges).toEqual(original.edges); expect(result.snapshot.sources).toEqual(original.sources);
    expect(result.snapshot.nodes.map(node => node.id)).toEqual(original.nodes.map(node => node.id));
  });
  it('rejects stale proposals after a manual edit', async () => {
    const service = configured(providerMock()); const original = snapshot();
    const proposal = await service.propose(original, { enabled: true });
    service.mutate(original, { type: 'rename', groupId: 'auth', label: 'Identity' });
    expect(() => service.apply(original, proposal.id)).toThrow('changed since this proposal');
  });
  it('supports rename, move, split, merge and exact undo without changing source facts', () => {
    const service = new GroupingService(); const original = snapshot();
    const rename = service.mutate(original, { type: 'rename', groupId: 'auth', label: 'Identity' });
    expect(rename.snapshot.groups[0]!.label).toBe('Identity');
    const moved = service.mutate(rename.snapshot, { type: 'move', fileIds: ['c'], groupId: 'auth' });
    expect(moved.snapshot.nodes.find(node => node.id === 'c')!.groupId).toBe('auth');
    const split = service.mutate(moved.snapshot, { type: 'split', groupId: 'auth', fileIds: ['a'], label: 'Session' });
    const newGroup = split.snapshot.nodes[0]!.groupId; expect(newGroup).not.toBe('auth');
    const merged = service.mutate(split.snapshot, { type: 'merge', groupIds: ['auth', newGroup], label: 'Identity' });
    expect(merged.snapshot.nodes[0]!.groupId).toBe('auth');
    const undone = service.undo(merged.snapshot);
    expect(undone.snapshot).toEqual(split.snapshot); expect(undone.revision.id).toBe(split.revision.id);
    expect(original.groups[0]!.label).toBe('Auth'); expect(original.nodes[2]!.groupId).toBe('billing');
  });
  it('rejects foreign, duplicate or invalid manual inputs', () => {
    const service = new GroupingService(); const value = snapshot();
    expect(() => service.mutate(value, { type: 'move', fileIds: ['unknown'], groupId: 'auth' })).toThrow('existing unique');
    expect(() => service.mutate(value, { type: 'move', fileIds: ['a', 'a'], groupId: 'auth' })).toThrow('existing unique');
    expect(() => service.mutate(value, { type: 'merge', groupIds: ['auth', 'auth'], label: 'Bad' })).toThrow('distinct');
    expect(() => service.mutate(value, { type: 'split', groupId: 'billing', fileIds: ['c'], label: 'Emptying' })).toThrow('proper subset');
    expect(() => service.mutate(value, { type: 'rename', groupId: 'auth', label: '<b>Identity</b>' })).toThrow('plain text');
    expect(() => service.undo(value)).toThrow('no earlier');
  });
  it('persists overrides and undo across a local process restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'constellation-grouping-')); directories.push(directory);
    const storagePath = join(directory, 'history.json');
    const first = new GroupingService({ storagePath });
    const renamed = first.mutate(snapshot(), { type: 'rename', groupId: 'auth', label: 'Identity' });
    const second = new GroupingService({ storagePath });
    expect(second.view(snapshot()).snapshot.groups[0]!.label).toBe('Identity');
    expect(second.undo(renamed.snapshot).snapshot.groups[0]!.label).toBe('Auth');
    expect(new GroupingService({ storagePath }).view(snapshot()).snapshot.groups[0]!.label).toBe('Auth');
  });
  it('keeps manual names and membership when models propose alternatives', async () => {
    const service = configured(providerMock({ moveToBilling: true, label: 'Automated' }));
    const moved = service.mutate(snapshot(), { type: 'move', fileIds: ['a'], groupId: 'billing' });
    const renamed = service.mutate(moved.snapshot, { type: 'rename', groupId: 'auth', label: 'User identity' });
    const proposal = await service.propose(renamed.snapshot, { enabled: true });
    expect(proposal.membership.a).toBe('billing'); expect(proposal.groups.find(group => group.id === 'auth')!.label).toBe('User identity');
    expect(proposal.decisions.some(decision => decision.fileId === 'a')).toBe(false);
  });
  it('reconciles new source-only files while preserving overrides', () => {
    const service = new GroupingService();
    const renamed = service.mutate(snapshot(), { type: 'rename', groupId: 'auth', label: 'Identity' });
    const extended = snapshot(); extended.nodes.push({ id: 'new', path: 'src/auth/new.ts', groupId: 'auth', sourceIds: [] });
    const view = service.view(extended);
    expect(view.snapshot.groups[0]!.label).toBe('Identity'); expect(view.revision.membership.new).toBe('auth'); expect(view.revision.id).not.toBe(renamed.revision.id);
    const undone = service.undo(view.snapshot);
    expect(undone.snapshot.groups[0]!.label).toBe('Auth'); expect(undone.revision.membership.new).toBe('auth');
  });
});
