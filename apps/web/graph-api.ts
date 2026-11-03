import { createHash } from 'node:crypto';
import type { GraphSnapshot } from '@patchwork/contracts';
export function graphVersion(snapshot: GraphSnapshot) {
  return createHash('sha256').update(JSON.stringify([snapshot.schemaVersion, snapshot.id, snapshot.contextSha, snapshot.groups, snapshot.nodes.map(node => [node.id, node.groupId, node.sourceIds]), snapshot.sources.map(source => [source.id, source.headSha, source.files.length]), snapshot.edges.map(edge => edge.id)])).digest('hex').slice(0, 24);
}
const bad = (message: string, status = 400, code = 'INVALID_PAGE') => Object.assign(new Error(message), { status, code });
function groupSummaries(snapshot: GraphSnapshot) {
  const counts = new Map<string, number>(); for (const node of snapshot.nodes) counts.set(node.groupId, (counts.get(node.groupId) ?? 0) + 1);
  return snapshot.groups.map(group => ({ id: group.id, label: group.label, component: group.component, color: group.color, origin: group.origin, parentId: group.parentId, fileCount: counts.get(group.id) ?? 0 }));
}
export function graphMetadata(snapshot: GraphSnapshot) {
  return { schemaVersion: '1', id: snapshot.id, version: graphVersion(snapshot), repository: snapshot.repository, contextSha: snapshot.contextSha, contextRef: snapshot.contextRef, coverage: snapshot.coverage,
    counts: { files: snapshot.nodes.length, edges: snapshot.edges.length, groups: snapshot.groups.length, sources: snapshot.sources.length },
    groups: groupSummaries(snapshot).slice(0, 200), groupsTruncated: snapshot.groups.length > 200,
    paging: { maxNodes: 500, maxEdges: 1_000, maxBytes: 512_000, defaultLimit: 200 },
    links: { groups: `/api/graphs/${encodeURIComponent(snapshot.id)}/chunks?kind=groups`, nodes: `/api/graphs/${encodeURIComponent(snapshot.id)}/chunks?kind=nodes`, edges: `/api/graphs/${encodeURIComponent(snapshot.id)}/chunks?kind=edges` } };
}
export function graphChunk(snapshot: GraphSnapshot, params: URLSearchParams) {
  const version = graphVersion(snapshot), kind = params.get('kind') ?? 'nodes', groupId = params.get('groupId');
  if (kind !== 'nodes' && kind !== 'edges' && kind !== 'groups') throw bad('Choose groups, nodes or edges.');
  if (groupId && !snapshot.groups.some(group => group.id === groupId)) throw bad('Unknown island.');
  const limit = Number(params.get('limit') ?? 200), max = kind === 'groups' ? 200 : kind === 'nodes' ? 500 : 1_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw bad(`Limit must be between 1 and ${max}.`);
  let offset = 0;
  const encoded = params.get('cursor');
  if (encoded) {
    if (encoded.length > 1_000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw bad('Invalid cursor.');
    let cursor: { version?: string; kind?: string; groupId?: string | null; offset?: number };
    try { cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { throw bad('Invalid cursor.'); }
    if (cursor.version !== version) throw bad('The graph revision changed. Reload metadata and restart paging.', 409, 'STALE_VERSION');
    if (cursor.kind !== kind || cursor.groupId !== groupId || !Number.isInteger(cursor.offset) || cursor.offset! < 0) throw bad('Cursor does not match this page scope.');
    offset = cursor.offset!;
  }
  if (params.has('version') && params.get('version') !== version) throw bad('The graph revision changed. Reload metadata.', 409, 'STALE_VERSION');
  const nodes = groupId ? snapshot.nodes.filter(node => node.groupId === groupId) : snapshot.nodes;
  const ids = new Set(nodes.map(node => node.id));
  const edges = snapshot.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
  const data = kind === 'groups' ? groupSummaries(snapshot).filter(group => !groupId || group.id === groupId) : kind === 'nodes' ? nodes : edges;
  if (offset > data.length) throw bad('Cursor is outside this graph.');
  const items: unknown[] = []; let bytes = 0;
  for (const item of data.slice(offset, offset + limit)) { const size = Buffer.byteLength(JSON.stringify(item)); if (bytes + size > 480_000) break; items.push(item); bytes += size; }
  if (!items.length && offset < data.length) throw bad('A graph item exceeds the response budget.', 413, 'PAYLOAD_LIMIT');
  const nextOffset = offset + items.length;
  return { schemaVersion: '1', snapshotId: snapshot.id, version, kind, groupId, items, total: data.length,
    nextCursor: nextOffset < data.length ? Buffer.from(JSON.stringify({ version, kind, groupId, offset: nextOffset })).toString('base64url') : null,
    coverage: snapshot.coverage, excludedCrossGroupEdges: groupId ? snapshot.edges.length - edges.length : 0,
    edgeEndpointScope: groupId ? 'selected-group' : 'all-snapshot-nodes', payloadBytes: bytes };
}
export function fileDetail(snapshot: GraphSnapshot, id: string) {
  const file = snapshot.nodes.find(node => node.id === id); if (!file) throw bad('File is unavailable in this graph.', 404, 'FILE_NOT_FOUND');
  const neighbors = snapshot.edges.filter(edge => edge.source === id || edge.target === id);
  const detail = { schemaVersion: '1', snapshotId: snapshot.id, version: graphVersion(snapshot), file,
    sources: snapshot.sources.filter(source => source.files.some(change => change.fileId === id)).map(source => ({ id: source.id, kind: source.kind, title: source.title, url: source.url, baseSha: source.baseSha, headSha: source.headSha, comparisonKind: source.comparisonKind, changes: source.files.filter(change => change.fileId === id) })),
    edges: neighbors.slice(0, 200), neighborCount: neighbors.length, neighborsTruncated: neighbors.length > 200, coverage: snapshot.coverage };
  if (Buffer.byteLength(JSON.stringify(detail)) > 512_000) throw bad('File detail exceeds its response budget. Use paged graph endpoints.', 413, 'PAYLOAD_LIMIT');
  return detail;
}
