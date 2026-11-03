import type { ChangeSource, GraphSnapshot } from '@patchwork/contracts';

export type SourceKind = 'pr' | 'commit';
export type SharedCamera = { x: number; y: number; zoom: number };
export type SharedView = { kind: SourceKind; sourceIds: string[] | null; fileId: string | null; camera?: SharedCamera; warning?: string };
export const MAX_SELECTED_SOURCES = 20;

/** null means no explicit selection; [] deliberately restores the context-only view. */
export function parseSharedView(search: string): SharedView {
  const params = new URLSearchParams(search);
  const sourceIds = params.has('sources') ? [...new Set((params.get('sources') || '').split(',').filter(Boolean))] : null;
  const cameraParts = params.get('camera')?.split(',').map(Number);
  const camera = cameraParts?.length === 3 && cameraParts.every(Number.isFinite)
    && Math.abs(cameraParts[0]) <= 10_000_000 && Math.abs(cameraParts[1]) <= 10_000_000
    && cameraParts[2] >= .001 && cameraParts[2] <= 100
    ? { x: cameraParts[0], y: cameraParts[1], zoom: cameraParts[2] } : undefined;
  return {
    kind: params.get('mode') === 'commit' ? 'commit' : 'pr',
    sourceIds: sourceIds?.slice(0, MAX_SELECTED_SOURCES) ?? null,
    fileId: params.get('file'), camera,
    ...(sourceIds && sourceIds.length > MAX_SELECTED_SOURCES ? { warning: `The shared view exceeds the ${MAX_SELECTED_SOURCES}-change limit. Only the first ${MAX_SELECTED_SOURCES} are selected; review the selection before continuing.` } : {}),
  };
}

export function initialSelection(snapshot: GraphSnapshot, view?: SharedView): { kind: SourceKind; ids: string[] } {
  const kind = view?.kind || 'pr';
  return { kind, ids: view?.sourceIds ?? snapshot.sources.filter(source => source.kind === kind).slice(0, kind === 'pr' ? 3 : 2).map(source => source.id) };
}

export function mergeSourcePages(existing: ChangeSource[], incoming: ChangeSource[]): ChangeSource[] {
  const byId = new Map(existing.map(source => [source.id, source]));
  for (const source of incoming) if (!byId.has(source.id)) byId.set(source.id, source);
  return [...byId.values()];
}

/** Discover saved IDs beyond page one before asking the server to load their footprint. */
export async function discoverSelectedSources(
  snapshot: GraphSnapshot, kind: SourceKind, ids: string[],
  fetchPage: (page: number) => Promise<{ sources: ChangeSource[]; nextPage: number | null }>,
  signal: AbortSignal,
): Promise<ChangeSource[]> {
  let sources = snapshot.sources;
  let page: number | null = 1;
  let requests = 0;
  const missing = () => ids.filter(id => !sources.some(source => source.id === id && source.kind === kind));
  while (missing().length && page !== null && requests++ < 10) {
    signal.throwIfAborted();
    const result = await fetchPage(page);
    signal.throwIfAborted();
    sources = mergeSourcePages(sources, result.sources);
    page = result.nextPage;
  }
  if (missing().length) throw new Error(`Saved changes are unavailable in the first 300 recent results: ${missing().join(', ')}. They may be deleted or inaccessible. Clear the selection or choose available changes; refresh to recheck access.`);
  return sources;
}

export function sharedViewQuery(search: string, snapshot: GraphSnapshot, kind: SourceKind, ids: string[], fileId: string | null, camera?: SharedCamera): string {
  const params = new URLSearchParams(search);
  params.set('mode', kind); params.set('sources', [...new Set(ids)].join(','));
  if (snapshot.mode === 'github') { params.set('repo', snapshot.repository.fullName); params.set('context', snapshot.contextSha); }
  else { params.delete('repo'); params.delete('context'); }
  if (fileId) params.set('file', fileId); else params.delete('file');
  if (camera) params.set('camera', [camera.x, camera.y, camera.zoom].map(value => Number(value.toFixed(5))).join(','));
  else params.delete('camera');
  return params.toString();
}
