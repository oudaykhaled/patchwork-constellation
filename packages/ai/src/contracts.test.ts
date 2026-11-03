import { describe, expect, it, vi } from 'vitest';
import { demoSnapshot } from '@patchwork/fixtures';
import { GroupingService, GroupingProposalSchema, GroupingRevisionSchema, MembershipDecisionSchema, validateGroupingProposal, validateGroupingRevision, validateMembershipDecision } from './index';

const snapshot = () => structuredClone(demoSnapshot);

describe('versioned enrichment contract', () => {
  it('wraps the canonical DATA-06 hierarchy without changing paths, IDs or coverage', () => {
    const value = snapshot();
    const before = structuredClone(value);
    const revision = new GroupingService().current(value);
    expect(revision).toMatchObject({ schemaVersion: '1', status: 'accepted', origin: 'rules', provenance: { snapshotId: value.id, contextSha: value.contextSha, source: 'canonical' } });
    expect(revision.canonicalHierarchy.groups).toEqual(value.groups);
    expect(revision.canonicalHierarchy.membership).toEqual(Object.fromEntries(value.nodes.map(file => [file.id, file.groupId])));
    expect(Object.keys(revision.membership)).toHaveLength(212);
    expect(value).toEqual(before);
    expect(GroupingRevisionSchema.safeParse({ ...revision, schemaVersion: undefined }).success).toBe(false);
    expect(GroupingRevisionSchema.safeParse({ ...revision, status: 'proposed' }).success).toBe(false);
  });

  it('retains physical facts when semantic labels, membership and secondary tags change', () => {
    const value = snapshot();
    const service = new GroupingService();
    const canonical = service.current(value).canonicalHierarchy;
    const renamed = service.mutate(value, { type: 'rename', groupId: value.groups[0]!.id, label: 'Identity service' });
    const moved = service.mutate(value, { type: 'move', fileIds: [value.nodes[0]!.id], groupId: value.groups[1]!.id });
    const enriched = validateGroupingRevision({ ...moved.revision, secondaryTags: { [value.nodes[0]!.id]: ['shared authentication', 'reviewed'] } }, value);
    expect(renamed.revision.groups[0]!.label).toBe('Identity service');
    expect(enriched.canonicalHierarchy).toEqual(canonical);
    expect(enriched.membership[value.nodes[0]!.id]).toBe(value.groups[1]!.id);
    expect(enriched.secondaryTags?.[value.nodes[0]!.id]).toEqual(['shared authentication', 'reviewed']);
    expect(moved.snapshot.nodes.map(file => [file.id, file.path])).toEqual(value.nodes.map(file => [file.id, file.path]));
    expect(moved.snapshot.edges).toEqual(value.edges);
    expect(moved.snapshot.sources).toEqual(value.sources);
  });

  it('rejects missing, foreign, dangling and duplicate hierarchy identities', () => {
    const value = snapshot();
    const revision = new GroupingService().current(value);
    const missing = structuredClone(revision);
    delete missing.membership[value.nodes[0]!.id];
    expect(() => validateGroupingRevision(missing, value)).toThrow('exactly one');
    expect(() => validateGroupingRevision({ ...revision, membership: { ...revision.membership, invented: value.groups[0]!.id } }, value)).toThrow('exactly one');
    expect(() => validateGroupingRevision({ ...revision, groups: [...revision.groups, revision.groups[0]] }, value)).toThrow('exactly one');
    expect(() => validateGroupingRevision({ ...revision, snapshotId: 'other' }, value)).toThrow('different snapshot');
    expect(() => validateGroupingRevision({ ...revision, provenance: { ...revision.provenance, contextSha: 'other' } }, value)).toThrow('different snapshot');
    expect(() => validateGroupingRevision({ ...revision, provenance: { ...revision.provenance, source: 'model' } }, value)).toThrow('provenance');
    expect(() => validateGroupingRevision({ ...revision, secondaryTags: { invented: ['name'] } }, value)).toThrow('Secondary tags');
  });

  it('binds decisions to known snapshot evidence and distinguishes unavailable confidence', () => {
    const value = snapshot();
    const file = value.nodes[0]!;
    const decision = { schemaVersion: '1' as const, snapshotId: value.id, fileId: file.id, groupId: file.groupId, origin: 'ai-jev' as const, evidenceIds: [`file:${file.id}`], rationale: 'Observed module path supports the existing island.' };
    expect(validateMembershipDecision(decision, value).confidence).toBeUndefined();
    expect(MembershipDecisionSchema.safeParse({ ...decision, schemaVersion: undefined }).success).toBe(false);
    expect(() => validateMembershipDecision({ ...decision, evidenceIds: ['file:foreign'] }, value)).toThrow('outside this snapshot');
    expect(() => validateMembershipDecision({ ...decision, evidenceIds: [`file:${file.id}`, `file:${file.id}`] }, value)).toThrow('outside this snapshot');
    expect(() => validateMembershipDecision({ ...decision, snapshotId: 'other' }, value)).toThrow('different snapshot');
    expect(() => validateMembershipDecision({ ...decision, fileId: 'unknown' }, value)).toThrow('unknown file');
    expect(() => validateMembershipDecision({ ...decision, groupId: 'unknown' }, value)).toThrow('unknown file');
  });

  it('keeps grouping revision stable as PR/commit overlays toggle', () => {
    const value = snapshot();
    const service = new GroupingService();
    const before = service.current(value);
    const overlay = structuredClone(value);
    overlay.sources = overlay.sources.filter(source => source.kind === 'commit');
    overlay.nodes.forEach(file => { file.sourceIds = []; file.status = 'unchanged'; });
    expect(service.current(overlay)).toEqual(before);
    overlay.sources = [];
    expect(service.current(overlay)).toEqual(before);
  });

  it('returns honest baseline/manual source labels without provider traffic', async () => {
    const transport = vi.fn<typeof fetch>();
    const service = new GroupingService({ enabled: true, fetch: transport });
    const value = snapshot();
    const fallback = await service.propose(value, { enabled: true });
    expect(fallback).toMatchObject({ schemaVersion: '1', status: 'baseline', origin: 'rules', provenance: { source: 'canonical' }, decisions: [], dataPolicy: { fieldsSent: [], analyzedFiles: 0 } });
    expect(GroupingProposalSchema.safeParse({ ...fallback, schemaVersion: undefined }).success).toBe(false);
    const current = service.mutate(value, { type: 'rename', groupId: value.groups[0]!.id, label: 'Reviewed identity' });
    const retained = await service.propose(value, { enabled: true });
    expect(retained.origin).toBe('manual');
    expect(retained.provenance.source).toBe('manual');
    expect(retained.groups).toEqual(current.revision.groups);
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects invented islands and false analysis claims at the proposal boundary', async () => {
    const value = snapshot();
    const fallback = await new GroupingService().propose(value);
    expect(() => validateGroupingProposal({ ...fallback, dataPolicy: { ...fallback.dataPolicy, analyzedFiles: 1 } }, value)).toThrow('cannot claim');
    const proposal = { ...fallback, status: 'proposed', origin: 'ai-jev', provenance: { ...fallback.provenance, source: 'model' } };
    expect(() => validateGroupingProposal({ ...proposal, groups: [...proposal.groups, { id: 'invented', label: 'Made up' }] }, value)).toThrow('unrecognized island');
    expect(() => validateGroupingProposal({ ...proposal, decisions: [{ schemaVersion: '1', snapshotId: value.id, fileId: value.nodes[0]!.id, groupId: value.groups[1]!.id, origin: 'ai-jev', evidenceIds: [`file:${value.nodes[0]!.id}`], rationale: 'Bounded evidence' }] }, value)).toThrow('match primary');
  });
});
