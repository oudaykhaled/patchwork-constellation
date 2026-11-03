import type { GraphSnapshot, Group } from '@patchwork/contracts';
import type { GroupingDelta, GroupingReviewItem, GroupingRevision } from './types';
import type { GroupingHistoryMetadata } from './history';

export function groupingDelta(snapshotId: string, previous: GroupingRevision, next: Pick<GroupingRevision, 'id' | 'groups' | 'membership'>): GroupingDelta {
  const nextGroups = new Set(next.groups.map(group => group.id));
  const membershipChanges = Object.keys(next.membership).sort().filter(fileId => previous.membership[fileId] !== next.membership[fileId]).map(fileId => ({ fileId, fromGroupId: previous.membership[fileId] ?? '', toGroupId: next.membership[fileId]! }));
  const groupMappings = Object.fromEntries(previous.groups.map(group => {
    if (nextGroups.has(group.id)) return [group.id, group.id];
    const survivingDestinations = new Set(Object.keys(previous.membership).filter(id => previous.membership[id] === group.id && next.membership[id]).map(id => next.membership[id]!));
    return [group.id, survivingDestinations.size === 1 ? [...survivingDestinations][0]! : null];
  }));
  return {
    schemaVersion: '1', snapshotId, fromRevisionId: previous.id, toRevisionId: next.id, membershipChanges, groupMappings,
    renamedGroups: previous.groups.flatMap(group => { const other = next.groups.find(item => item.id === group.id); return other && other.label !== group.label ? [{ groupId: group.id, fromLabel: group.label, toLabel: other.label }] : []; }),
  };
}

/** Carry only explicit manual overrides. Never infer rename from equal content or a fuzzy path. */
export function migrateManualOverrides(snapshot: GraphSnapshot, baseline: GroupingRevision, previous: GroupingRevision, metadata: GroupingHistoryMetadata): { groups: Group[]; membership: Record<string, string>; lockedFileIds: string[]; lockedGroupIds: string[]; reviewItems: GroupingReviewItem[] } {
  const groups = structuredClone(baseline.groups);
  const membership = structuredClone(baseline.membership);
  const lockedFileIds: string[] = [];
  const lockedGroupIds: string[] = [];
  const reviewItems: GroupingReviewItem[] = [];
  const nodeById = new Map(snapshot.nodes.map(node => [node.id, node]));
  for (const id of previous.lockedGroupIds) {
    const manual = previous.groups.find(group => group.id === id);
    const current = groups.find(group => group.id === id);
    if (manual && current) { Object.assign(current, structuredClone(manual)); lockedGroupIds.push(id); }
  }
  for (const previousId of previous.lockedFileIds) {
    const old = metadata.files[previousId];
    if (!old) continue;
    const same = nodeById.get(previousId);
    const candidates = snapshot.nodes.filter(node => {
      if (node.ambiguousLineage) return false;
      // A shared stable ID with the same path is retained unless ingestion explicitly
      // identifies an addition/delete-recreate. Source-only identity is not continuity.
      if (node.id === previousId && node.path === old.path && node.presence !== 'source-only' && node.presence !== 'added' && node.status !== 'added') return true;
      const aliases = Array.isArray(node.lineageAliases) ? node.lineageAliases : [];
      const confirmedSourceRename = snapshot.sources.some(source => source.files.some(change => change.fileId === node.id && change.status === 'renamed' && change.previousPath === old.path && change.path === node.path));
      return node.path !== old.path && (aliases.includes(old.path) || confirmedSourceRename);
    });
    const target = candidates.length === 1 ? candidates[0] : undefined;
    const ambiguous = snapshot.nodes.some(node => node.ambiguousLineage && (node.id === previousId || node.path === old.path || (Array.isArray(node.lineageAliases) && node.lineageAliases.includes(old.path))));
    if (!target || target.presence === 'deleted' || target.status === 'deleted' || target.status === 'removed') {
      reviewItems.push({ fileId: previousId, previousPath: old.path, previousGroupId: previous.membership[previousId]!, reason: target?.presence === 'deleted' || target?.status === 'deleted' || target?.status === 'removed' ? 'deleted-file' : candidates.length || same || ambiguous ? 'ambiguous-lineage' : 'removed-file' });
      continue;
    }
    const groupId = previous.membership[previousId]!;
    if (!groups.some(group => group.id === groupId)) {
      const manualGroup = previous.groups.find(group => group.id === groupId);
      if (!manualGroup) continue;
      // A copied manual group cannot retain a dangling parent from an older hierarchy.
      const copied = structuredClone(manualGroup);
      if (copied.parentId && !groups.some(group => group.id === copied.parentId)) delete copied.parentId;
      groups.push(copied);
    }
    membership[target.id] = groupId; lockedFileIds.push(target.id);
    if (previous.lockedGroupIds.includes(groupId) && !lockedGroupIds.includes(groupId)) lockedGroupIds.push(groupId);
  }
  return { groups, membership, lockedFileIds, lockedGroupIds, reviewItems };
}
