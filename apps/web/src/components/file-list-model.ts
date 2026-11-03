import type { GraphSnapshot } from '@patchwork/contracts';

export const FILE_LIST_WINDOW = 36;
export type FileListRow = {
  id: string; path: string; groupId: string; groupLabel: string;
  sourceCount: number; sourceLabels: string[]; statuses: string[];
  incoming: number; outgoing: number;
};

/** Selection membership, observed change kinds and directed imports stay separate. */
export function fileListRows(snapshot: GraphSnapshot, selectedIds: readonly string[]): FileListRow[] {
  const selected = new Set(selectedIds);
  const sources = snapshot.sources.filter(source => selected.has(source.id));
  const changes = new Map<string, { statuses: Set<string>; labels: string[] }>();
  for (const source of sources) for (const file of source.files) {
    const current = changes.get(file.fileId) ?? { statuses: new Set<string>(), labels: [] };
    current.statuses.add(file.status);
    if (!current.labels.includes(source.label || source.id)) current.labels.push(source.label || source.id);
    changes.set(file.fileId, current);
  }
  const connections = new Map<string, { incoming: number; outgoing: number }>();
  for (const edge of snapshot.edges) {
    const source = connections.get(edge.source) ?? { incoming: 0, outgoing: 0 };
    source.outgoing++; connections.set(edge.source, source);
    const target = connections.get(edge.target) ?? { incoming: 0, outgoing: 0 };
    target.incoming++; connections.set(edge.target, target);
  }
  const groups = new Map(snapshot.groups.map(group => [group.id, group.label]));
  return snapshot.nodes.map(node => {
    const observed = changes.get(node.id);
    const sourceIds = node.sourceIds.filter(id => selected.has(id));
    return { id: node.id, path: node.path, groupId: node.groupId,
      groupLabel: groups.get(node.groupId) ?? 'Ungrouped', sourceCount: sourceIds.length,
      sourceLabels: observed?.labels ?? [],
      statuses: observed ? [...observed.statuses].sort() : ['unchanged context'],
      ...connections.get(node.id) ?? { incoming: 0, outgoing: 0 } };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.id.localeCompare(b.id));
}

export function fileListWindow(total: number, requestedPage: number) {
  const pages = Math.max(1, Math.ceil(total / FILE_LIST_WINDOW));
  const page = Math.max(0, Math.min(pages - 1, requestedPage));
  return { page, pages, start: page * FILE_LIST_WINDOW, end: Math.min(total, (page + 1) * FILE_LIST_WINDOW) };
}
