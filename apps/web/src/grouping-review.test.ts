import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '@patchwork/fixtures';
import { describeEvidence, groupingSource, inspectProposal, parseReviewProposal } from './grouping-review';

describe('grouping review trust boundary', () => {
  const snapshot = createDemoSnapshot();
  const membership = Object.fromEntries(snapshot.nodes.map(node => [node.id, node.groupId]));
  const valid = { id: 'review', status: 'proposed', groups: snapshot.groups, membership };
  it('reports exact changed memberships without modifying observed facts', () => {
    const before = JSON.stringify(snapshot);
    const file = snapshot.nodes[0]!;
    const group = snapshot.groups.find(item => item.id !== file.groupId)!;
    expect(inspectProposal(snapshot, { ...valid, membership: { ...membership, [file.id]: group.id } }).changes).toEqual([{ fileId: file.id, fromGroupId: file.groupId, toGroupId: group.id }]);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it('rejects unknown IDs, missing membership and foreign evidence', () => {
    expect(inspectProposal(snapshot, { ...valid, membership: { ...membership, foreign: snapshot.groups[0]!.id } }).valid).toBe(false);
    const missing = { ...membership }; delete missing[snapshot.nodes[0]!.id];
    expect(inspectProposal(snapshot, { ...valid, membership: missing }).valid).toBe(false);
    expect(inspectProposal(snapshot, { ...valid, decisions: [{ fileId: snapshot.nodes[0]!.id, groupId: snapshot.groups[0]!.id, evidenceIds: ['foreign:secret'] }] }).valid).toBe(false);
  });
  it('uses readable paths and observed import relations instead of raw model traces', () => {
    expect(describeEvidence(snapshot, `file:${snapshot.nodes[0]!.id}`)).toBe(snapshot.nodes[0]!.path);
    expect(describeEvidence(snapshot, snapshot.edges[0]!.id)).toContain('→');
    expect(describeEvidence(snapshot, 'foreign')).toBeNull();
  });
  it('labels manual retained grouping before AI and does not invent confidence', () => {
    expect(groupingSource(snapshot, { id: 'r', origin: 'manual' })).toBe('Manual override');
    expect(groupingSource(snapshot, { id: 'r', origin: 'ai-jev' })).toBe('Approved AI + Jev proposal');
    expect(inspectProposal(snapshot, { ...valid, decisions: [{ fileId: snapshot.nodes[0]!.id, groupId: snapshot.nodes[0]!.groupId }] }).valid).toBe(true);
    expect(inspectProposal(snapshot, { status: 'baseline', message: 'Provider unavailable' }).valid).toBe(true);
  });
  it('turns malformed output into an honest retained state without rendering invalid values', () => {
    expect(parseReviewProposal({ status: 'proposed', groups: {}, message: { html: 'bad' } })).toMatchObject({ status: 'baseline', message: expect.stringContaining('invalid') });
    expect(parseReviewProposal({ ...valid, decisions: [{ fileId: 'known', confidence: Infinity }] }).status).toBe('baseline');
  });
});
