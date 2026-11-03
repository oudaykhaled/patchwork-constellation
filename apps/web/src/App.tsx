import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCheck, CircleHelp, FileCode2, FolderGit2, GitCommitHorizontal, GitPullRequest, Layers3, List, LoaderCircle, RefreshCw, RotateCcw, Search, ShieldCheck, Unplug, X } from 'lucide-react';
import type { ChangeSource, GraphSnapshot, Group } from '@patchwork/contracts';
import { ConstellationGraph } from './components/ConstellationGraph';
import { GroupingReview } from './components/GroupingReview';
import type { GraphLayout } from '../../../packages/graph-core/src/index';
import { groupingSource, parseReviewProposal, type ReviewProposal, type ReviewRevision } from './grouping-review';
import { GitHubAccount } from './components/GitHubAccount';
import { authenticatedFetch } from './github-session';
import { GraphLegend } from './components/GraphLegend';
import { discoverSelectedSources, initialSelection, MAX_SELECTED_SOURCES, mergeSourcePages, parseSharedView, sharedViewQuery, type SharedCamera, type SourceKind } from './selection-state';
import { FileInspector } from './components/FileInspector';
import { findFiles, groupBreadcrumb } from './file-evidence';
import { FileList } from './components/FileList';
import { ReviewAnnouncements } from './components/ReviewAnnouncements';
import './styles.css';

type DialogName = 'sources' | 'repository' | 'grouping' | 'list' | 'help' | null;
type GroupLevel = 'Modules' | 'Folders' | 'Components';
type GroupingProposal = ReviewProposal;
type RuntimeConfig = { github?: { configuredToken?: boolean }; ai?: { available?: boolean; configured?: boolean; message?: string; persistence?: string; evaluation?: { passed: boolean; reason?: string } }; [key: string]: unknown };
type GroupingResult = { snapshot: GraphSnapshot; revision?: ReviewRevision; canUndo?: boolean };

const design = (name: string) => `/design/${name}.svg`;
function DesignIcon({ name, size, className = '' }: { name: string; size?: number; className?: string }) {
  return <span className={`design-icon ${className}`} style={size ? { width: size, height: size } : undefined}><img src={design(name)} alt="" /></span>;
}
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await authenticatedFetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `Request failed (${response.status})`);
  return data as T;
}
const unwrapSnapshot = (value: GraphSnapshot | { snapshot: GraphSnapshot }) => 'snapshot' in value ? value.snapshot as GraphSnapshot : value as GraphSnapshot;
const basename = (path: string) => path.split('/').pop() || path;
const displayLabel = (source: ChangeSource) => source.label || (source.number ? `#${source.number}` : source.sha?.slice(0, 7)) || source.id;
const mergeSources = mergeSourcePages;

function Modal({ title, eyebrow, children, onClose, wide = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; const previous = document.activeElement as HTMLElement | null; dialog?.showModal(); return () => { dialog?.close(); previous?.focus(); }; }, []);
  return <dialog ref={ref} aria-label={title} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div><button className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><X size={18} /></button></div>
    {children}
  </dialog>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [kind, setKind] = useState<SourceKind>('pr');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionPhase, setSelectionPhase] = useState<'ready' | 'loading' | 'failed'>('ready');
  const [initialCamera, setInitialCamera] = useState<SharedCamera>();
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [focusGroupId, setFocusGroupId] = useState<string | null>(null);
  const [overviewRequest, setOverviewRequest] = useState(0);
  const [dialog, setDialog] = useState<DialogName>(null);
  const [query, setQuery] = useState('');
  const [sourceQuery, setSourceQuery] = useState('');
  const [listQuery, setListQuery] = useState('');
  const [repoInput, setRepoInput] = useState('');
  const [contextInput, setContextInput] = useState('');
  const [groupLevel, setGroupLevel] = useState<GroupLevel>('Modules');
  const [groupMenu, setGroupMenu] = useState(false);
  const [showImports, setShowImports] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [config, setConfig] = useState<RuntimeConfig>({});
  const [proposal, setProposal] = useState<GroupingProposal | null>(null);
  const [groupingRevision, setGroupingRevision] = useState<ReviewRevision | null>(null);
  const [groupingLoading, setGroupingLoading] = useState(false);
  const [explainedGroupId, setExplainedGroupId] = useState<string | null>(null);
  const [activeLayout, setActiveLayout] = useState<GraphLayout | null>(null);
  const [moveGroup, setMoveGroup] = useState('');
  const [hasUndo, setHasUndo] = useState(false);
  const [nextSourcePage, setNextSourcePage] = useState<number | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const jobRef = useRef<string | null>(null);
  const groupingAbortRef = useRef<AbortController | null>(null);
  const contextEpoch = useRef(0);
  const groupingRequest = useRef(0);
  const sourcePageRequest = useRef(0);
  const selectionRequest = useRef(0);
  const selectionAbortRef = useRef<AbortController | null>(null);
  const confirmedSelection = useRef<{ kind: SourceKind; ids: string[] }>({ kind: 'pr', ids: [] });
  const modeSelections = useRef<Partial<Record<SourceKind, string[]>>>({});
  const viewCamera = useRef<SharedCamera | undefined>(undefined);
  const pendingSharedFile = useRef<string | null>(null);
  const lastCameraWrite = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);
  const fileFocusRef = useRef<HTMLElement | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (message: string) => { setNotice(message); if (noticeTimer.current) clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 5000); };

  const installSnapshot = (next: GraphSnapshot, restoreUrl = false) => {
    contextEpoch.current++; groupingRequest.current++; groupingAbortRef.current?.abort();
    sourcePageRequest.current++; setNextSourcePage(null); setLoadingSources(false);
    selectionRequest.current++; selectionAbortRef.current?.abort(); setSelectionPhase('ready');
    setSnapshot(next); setSelectedFileId(null); setFocusGroupId(null); setQuery(''); setProposal(null); setGroupingRevision(null); setGroupingLoading(false); setExplainedGroupId(null); setActiveLayout(null); setHasUndo(false); setGroupLevel('Modules');
    const view = restoreUrl ? parseSharedView(location.search) : undefined;
    const selection = initialSelection(next, view);
    // Keep explicitly saved IDs, even when discovery has not loaded their page yet.
    // updateSelection checks them through the server rather than silently replacing them.
    setKind(selection.kind); setSelectedIds(selection.ids);
    modeSelections.current = { [selection.kind]: selection.ids };
    confirmedSelection.current = { kind: selection.kind, ids: next.mode === 'demo' ? selection.ids : [] };
    viewCamera.current = view?.camera; setInitialCamera(view?.camera);
    if (view?.warning) flash(view.warning);
    pendingSharedFile.current = view?.fileId || null;
    if (view?.fileId && next.nodes.some(node => node.id === view.fileId)) { setSelectedFileId(view.fileId); pendingSharedFile.current = null; }
    else if (next.mode === 'demo') pendingSharedFile.current = null;
    if (next.mode === 'demo' && selection.ids.some(id => !next.sources.some(source => source.id === id && source.kind === selection.kind))) {
      setSelectionPhase('failed'); setError('Some saved sample changes no longer exist. Choose available changes or clear the selection.');
    }
  };
  useEffect(() => {
    const controller = new AbortController(); setBusy('Opening constellation…');
    const params = new URLSearchParams(location.search);
    if (params.get('repo')) void analyzeTarget(params.get('repo')!, params.get('context') || undefined, true);
    else api<GraphSnapshot | { snapshot: GraphSnapshot }>('/api/demo', undefined, controller.signal).then(value => installSnapshot(unwrapSnapshot(value), true)).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setBusy(''); });
    api<RuntimeConfig>('/api/config', undefined, controller.signal).then(setConfig).catch(() => {});
    return () => { controller.abort(); abortRef.current?.abort(); selectionAbortRef.current?.abort(); groupingAbortRef.current?.abort(); if (noticeTimer.current) clearTimeout(noticeTimer.current); };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === '/' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !dialog) { event.preventDefault(); searchRef.current?.focus(); } if (event.key === 'Escape' && !dialog) { setSelectedFileId(null); setQuery(''); setGroupMenu(false); const previous = fileFocusRef.current; if (previous?.isConnected) previous.focus({ preventScroll: true }); else searchRef.current?.focus({ preventScroll: true }); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);
  useEffect(() => {
    if (!selectedFileId || dialog || document.activeElement?.tagName === 'CANVAS') return;
    const frame = requestAnimationFrame(() => inspectorCloseRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [selectedFileId, dialog]);
  useEffect(() => {
    if (!snapshot) return;
    history.replaceState(null, '', `${location.pathname}?${sharedViewQuery(location.search, snapshot, kind, selectedIds, selectedFileId || pendingSharedFile.current, viewCamera.current)}`);
  }, [snapshot?.id, kind, selectedIds, selectedFileId]);
  useEffect(() => {
    if (!snapshot || snapshot.mode === 'demo' || dialog !== 'sources') return;
    sourcePageRequest.current++; setNextSourcePage(null);
    const controller = new AbortController(); setLoadingSources(true);
    api<{ sources: ChangeSource[]; nextPage: number | null; snapshot?: GraphSnapshot }>(`/api/sources?snapshotId=${encodeURIComponent(snapshot.id)}&kind=${kind}&page=1`, undefined, controller.signal).then(result => { setNextSourcePage(result.nextPage); setSnapshot(current => current?.id === snapshot.id ? { ...current, sources: mergeSources(current.sources, result.sources) } : current); }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoadingSources(false); });
    return () => { controller.abort(); sourcePageRequest.current++; };
  }, [dialog, kind, snapshot?.id, snapshot?.mode]);
  useEffect(() => { if (snapshot?.mode === 'github') void updateSelection(selectedIds, kind); }, [snapshot?.id]);
  useEffect(() => { if (snapshot) void reloadGrouping(false); }, [snapshot?.id]);
  useEffect(() => { if (dialog === 'grouping' && snapshot) void reloadGrouping(); }, [dialog, snapshot?.id]);

  const presentationSnapshot = useMemo(() => {
    if (!snapshot || groupLevel === 'Modules') return snapshot;
    const groups = new Map<string, Group>();
    const nodes = snapshot.nodes.map(node => { const original = snapshot.groups.find(group => group.id === node.groupId); const label = groupLevel === 'Folders' ? node.path.split('/').slice(0, -1).slice(0, 2).join('/') || '(root)' : original?.component || original?.label || 'Ungrouped'; const id = `${groupLevel.toLowerCase()}:${label}`; if (!groups.has(id)) groups.set(id, { id, label, origin: 'rules', color: original?.color }); return { ...node, groupId: id }; });
    return { ...snapshot, id: `${snapshot.id}:${groupLevel}`, nodes, groups: [...groups.values()] };
  }, [snapshot, groupLevel]);
  const sources = snapshot?.sources.filter(source => source.kind === kind) || [];
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedSources = sources.filter(source => selectedSet.has(source.id));
  const memberships = useMemo(() => new Map((snapshot?.nodes || []).map(node => [node.id, node.sourceIds.filter(id => selectedSet.has(id))])), [snapshot, selectedSet]);
  const changedNodes = snapshot?.nodes.filter(node => (memberships.get(node.id)?.length || 0) > 0) || [];
  const overlapCount = changedNodes.filter(node => (memberships.get(node.id)?.length || 0) > 1).length;
  const affectedIslands = new Set((presentationSnapshot?.nodes || []).filter(node => (memberships.get(node.id)?.length || 0) > 0).map(node => node.groupId)).size;
  const selectedFile = snapshot?.nodes.find(node => node.id === selectedFileId);
  const focusGroup = presentationSnapshot?.groups.find(group => group.id === focusGroupId);
  const matchingFiles = useMemo(() => findFiles(snapshot, query), [query, snapshot]);
  const matchingGroups = !query.trim() ? [] : (presentationSnapshot?.groups || []).filter(group => group.label.toLowerCase().includes(query.toLowerCase())).slice(0, 3);


  const chooseFile = (id: string | null) => { pendingSharedFile.current = null; if (id && !selectedFileId) fileFocusRef.current = document.activeElement as HTMLElement; setSelectedFileId(id); setQuery(''); if (id) { const node = snapshot?.nodes.find(file => file.id === id); if (node) setMoveGroup(node.groupId); } else { const target = fileFocusRef.current; if (target?.isConnected) target.focus({ preventScroll: true }); else searchRef.current?.focus({ preventScroll: true }); } };
  const updateSelection = async (ids: string[], nextKind = kind) => {
    ids = [...new Set(ids)];
    if (ids.length > MAX_SELECTED_SOURCES) { flash(`Select up to ${MAX_SELECTED_SOURCES} changes at a time.`); return; }
    selectionAbortRef.current?.abort();
    const controller = new AbortController(); selectionAbortRef.current = controller;
    const requestId = ++selectionRequest.current; const epoch = contextEpoch.current;
    const isCurrent = () => !controller.signal.aborted && requestId === selectionRequest.current && epoch === contextEpoch.current;
    setSelectedIds(ids); setKind(nextKind); modeSelections.current[nextKind] = ids; setError('');
    if (!snapshot || snapshot.mode === 'demo') {
      selectionAbortRef.current = null;
      if (snapshot && ids.some(id => !snapshot.sources.some(source => source.id === id && source.kind === nextKind))) { setSelectionPhase('failed'); setError('Some saved sample changes no longer exist. Choose available changes or clear the selection.'); return; }
      confirmedSelection.current = { kind: nextKind, ids }; setSelectionPhase('ready'); return;
    }
    setSelectionPhase('loading'); setBusy('Updating selected changes…');
    try {
      const discovered = await discoverSelectedSources(snapshot, nextKind, ids, page => api<{ sources: ChangeSource[]; nextPage: number | null }>(`/api/sources?snapshotId=${encodeURIComponent(snapshot.id)}&kind=${nextKind}&page=${page}`, undefined, controller.signal), controller.signal);
      if (!isCurrent()) return;
      setSnapshot(current => current?.id === snapshot.id ? { ...current, sources: mergeSources(current.sources, discovered) } : current);
      const result = await api<GraphSnapshot | { snapshot: GraphSnapshot }>('/api/sources', { snapshotId: snapshot.id, kind: nextKind, ids }, controller.signal);
      if (isCurrent()) {
        const next = unwrapSnapshot(result); setSnapshot(next); confirmedSelection.current = { kind: nextKind, ids }; setSelectionPhase('ready');
        if (pendingSharedFile.current) {
          if (next.nodes.some(node => node.id === pendingSharedFile.current)) setSelectedFileId(pendingSharedFile.current);
          else flash('The shared file is unavailable in this context and selection. The repository map is preserved.');
          pendingSharedFile.current = null;
        }
      }
    }
    catch (reason) { if (isCurrent()) { setSelectionPhase('failed'); setError((reason as Error).message); } }
    finally { if (isCurrent()) { setBusy(''); selectionAbortRef.current = null; } }
  };
  const toggleSource = (id: string) => { void updateSelection(selectedSet.has(id) ? selectedIds.filter(value => value !== id) : [...selectedIds, id]); };
  const switchKind = (next: SourceKind) => { if (!snapshot || next === kind) return; setSourceQuery(''); void updateSelection(modeSelections.current[next] ?? snapshot.sources.filter(source => source.kind === next).slice(0, next === 'pr' ? 3 : 2).map(source => source.id), next); };
  const loadDemo = async () => { let installed = false; const epoch = ++contextEpoch.current; selectionRequest.current++; selectionAbortRef.current?.abort(); groupingAbortRef.current?.abort(); abortRef.current?.abort(); setBusy('Opening demo…'); setError(''); try { const next = unwrapSnapshot(await api<GraphSnapshot | { snapshot: GraphSnapshot }>('/api/demo')); if (epoch !== contextEpoch.current) return; installSnapshot(next); installed = true; setDialog(null); } catch (reason) { if (epoch === contextEpoch.current) setError((reason as Error).message); } finally { if (epoch === contextEpoch.current || installed) setBusy(''); } };
  async function analyzeTarget(repository: string, contextRef?: string, restoreUrl = false) {
    if (!repository.trim()) return;
    contextEpoch.current++; groupingAbortRef.current?.abort();
    selectionRequest.current++; selectionAbortRef.current?.abort();
    abortRef.current?.abort(); const controller = new AbortController(); abortRef.current = controller; setError(''); setBusy('Connecting to repository…');
    try {
      const result = await api<{ jobId?: string; id?: string; snapshot?: GraphSnapshot }>('/api/analyze', { repository: repository.trim(), contextRef, mode: 'pr' }, controller.signal);
      if (result.snapshot) { installSnapshot(result.snapshot, restoreUrl); setDialog(null); return; }
      const jobId = result.jobId || result.id; if (!jobId) throw new Error('The analysis did not return a job. Please try again.');
      jobRef.current = jobId;
      while (!controller.signal.aborted) {
        const job = await api<{ status: string; progress?: number | string; message?: string; snapshot?: GraphSnapshot; error?: string | { message?: string } }>(`/api/jobs/${encodeURIComponent(jobId)}`, undefined, controller.signal);
        if (job.snapshot && ['ready', 'partial', 'complete', 'completed'].includes(job.status)) { installSnapshot(job.snapshot, restoreUrl); setDialog(null); flash('Repository map is ready. Select changes to explore their footprint.'); break; }
        if (['failed', 'cancelled'].includes(job.status)) throw new Error(typeof job.error === 'string' ? job.error : job.error?.message || 'Analysis could not complete.');
        setBusy(job.message || `${job.status.charAt(0).toUpperCase()}${job.status.slice(1)}${typeof job.progress === 'number' ? ` · ${Math.round(job.progress)}%` : '…'}`);
        await new Promise<void>((resolve, reject) => { const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }; const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, 1000); controller.signal.addEventListener('abort', onAbort, { once: true }); });
      }
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
    finally { if (abortRef.current === controller) { setBusy(''); abortRef.current = null; jobRef.current = null; } }
  }
  const connectRepository = (event: FormEvent) => { event.preventDefault(); void analyzeTarget(repoInput, contextInput.trim() || undefined); };
  const cancelAnalysis = () => {
    if (selectionAbortRef.current) {
      selectionRequest.current++; selectionAbortRef.current.abort(); selectionAbortRef.current = null;
      const previous = confirmedSelection.current; setKind(previous.kind); setSelectedIds(previous.ids); modeSelections.current[previous.kind] = previous.ids; setSelectionPhase('ready');
    }
    if (jobRef.current) void api(`/api/jobs/${encodeURIComponent(jobRef.current)}/cancel`, {}).catch(() => {});
    jobRef.current = null; abortRef.current?.abort(); abortRef.current = null; setBusy(''); flash('Analysis canceled. Your current map is preserved.');
  };
  const loadMoreSources = async () => { if (!snapshot || !nextSourcePage) return; const generation = sourcePageRequest.current; setLoadingSources(true); try { const result = await api<{ sources: ChangeSource[]; nextPage: number | null }>(`/api/sources?snapshotId=${encodeURIComponent(snapshot.id)}&kind=${kind}&page=${nextSourcePage}`); if (generation !== sourcePageRequest.current) return; setSnapshot(current => current?.id === snapshot.id ? { ...current, sources: mergeSources(current.sources, result.sources) } : current); setNextSourcePage(result.nextPage); } catch (reason) { if (generation === sourcePageRequest.current) setError((reason as Error).message); } finally { if (generation === sourcePageRequest.current) setLoadingSources(false); } };
  async function runGroupingTask<T>(message: string, task: (signal: AbortSignal) => Promise<T>, apply: (result: T) => void) {
    groupingAbortRef.current?.abort();
    setGroupingLoading(false);
    const controller = new AbortController(); groupingAbortRef.current = controller;
    const epoch = contextEpoch.current; const requestId = ++groupingRequest.current;
    const isCurrent = () => !controller.signal.aborted && epoch === contextEpoch.current && requestId === groupingRequest.current;
    setBusy(message); setError('');
    try { const result = await task(controller.signal); if (isCurrent()) apply(result); }
    catch (reason) { if (isCurrent()) setError((reason as Error).message); }
    finally { if (isCurrent()) { setBusy(''); groupingAbortRef.current = null; } }
  }
  const adoptGrouping = (result: GroupingResult) => {
    // A grouping response updates organization, preserving a concurrently refreshed source overlay.
    setSnapshot(current => {
      if (!current || current.id !== result.snapshot.id) return current;
      const membership = new Map(result.snapshot.nodes.map(node => [node.id, node.groupId]));
      const nodes = current.nodes.map(node => ({ ...node, groupId: membership.get(node.id) ?? node.groupId }));
      const groups = [...result.snapshot.groups];
      for (const node of nodes) if (!groups.some(group => group.id === node.groupId)) { const group = current.groups.find(item => item.id === node.groupId); if (group) groups.push(group); }
      return { ...current, nodes, groups };
    });
    setGroupingRevision(result.revision ?? null);
    setHasUndo(result.canUndo ?? Boolean(result.revision?.parentRevisionId));
  };
  async function reloadGrouping(clearError = true) {
    if (!snapshot) return;
    groupingAbortRef.current?.abort();
    const controller = new AbortController(); groupingAbortRef.current = controller;
    const epoch = contextEpoch.current; const requestId = ++groupingRequest.current;
    const isCurrent = () => !controller.signal.aborted && epoch === contextEpoch.current && requestId === groupingRequest.current;
    setGroupingLoading(true); if (clearError) setError('');
    try {
      const result = await api<GroupingResult>(`/api/grouping/current?snapshotId=${encodeURIComponent(snapshot.id)}`, undefined, controller.signal);
      if (isCurrent()) { adoptGrouping(result); setProposal(null); }
    } catch (reason) { if (isCurrent()) setError((reason as Error).message); }
    finally { if (isCurrent()) { setGroupingLoading(false); groupingAbortRef.current = null; } }
  }
  const requestGrouping = async () => { if (!snapshot) return; await runGroupingTask('Reviewing module evidence…', signal => api<unknown>('/api/grouping', { snapshotId: snapshot.id, enabled: true }, signal), result => setProposal(parseReviewProposal(result))); };
  const mutateGrouping = async (operation: unknown) => { if (!snapshot) return; if (!groupingRevision) { setError('Load the current grouping revision before editing.'); setDialog('grouping'); return; } selectionRequest.current++; selectionAbortRef.current?.abort(); await runGroupingTask('Updating grouping…', signal => api<GroupingResult>('/api/grouping/mutate', { snapshotId: snapshot.id, operation, expectedRevisionId: groupingRevision.id }, signal), result => { adoptGrouping(result); setProposal(null); flash('Grouping updated. You can undo this change.'); }); };
  const undoGrouping = async () => { if (!snapshot) return; selectionRequest.current++; selectionAbortRef.current?.abort(); await runGroupingTask('Restoring previous grouping…', signal => api<GroupingResult>('/api/grouping/undo', { snapshotId: snapshot.id, expectedRevisionId: groupingRevision?.id }, signal), result => { adoptGrouping(result); setProposal(null); flash('Previous grouping and layout restored.'); }); };
  const applyProposal = async () => { if (!snapshot || !proposal?.id) return; selectionRequest.current++; selectionAbortRef.current?.abort(); await runGroupingTask('Applying grouping…', signal => api<GroupingResult>('/api/grouping/apply', { snapshotId: snapshot.id, proposalId: proposal.id, expectedRevisionId: groupingRevision?.id }, signal), result => { adoptGrouping(result); setHasUndo(result.canUndo ?? true); setProposal(null); setDialog(null); flash('Reviewed grouping applied.'); }); };
  const rejectProposal = async () => { if (!snapshot || !proposal?.id) return; await runGroupingTask('Rejecting proposal…', signal => api('/api/grouping/reject', { snapshotId: snapshot.id, proposalId: proposal.id, expectedRevisionId: groupingRevision?.id }, signal), () => { setProposal(null); flash('Proposal rejected. Your current grouping is retained.'); }); };
  const explainGroup = (id: string) => { setExplainedGroupId(id); setDialog('grouping'); };
  const saveView = async () => { if (snapshot) history.replaceState(null, '', `${location.pathname}?${sharedViewQuery(location.search, snapshot, kind, selectedIds, selectedFileId || pendingSharedFile.current, viewCamera.current)}`); const url = location.href; localStorage.setItem('patchwork:saved-view', url); try { await navigator.clipboard.writeText(url); flash('View saved. Share link copied to clipboard.'); } catch { flash('View saved in this browser. The address bar contains your share link.'); } };
  const focusIsland = (id: string | null) => { setFocusGroupId(id); setQuery(''); };

  return <div className="app-shell">
    <a className="skip-link" href="#graph-workspace">Skip to graph workspace</a>
    <header className="global-header" data-node-id="17:2114">
      <a className="brand" href="/" aria-label="Patchwork home"><DesignIcon name="0-imgIconGraph" size={25} /><span>patchwork</span></a>
      <button className="repo-switch" onClick={() => setDialog('repository')} aria-label="Choose repository"><DesignIcon name="0-imgIconBranch" size={15} /><span>{snapshot ? `${snapshot.repository.owner} / ${snapshot.repository.name}` : 'Choose repository'}</span><DesignIcon name="0-imgIconChevron" size={12} /></button>
      <span className="header-slash">/</span><span className="page-name">Impact graph</span>
      <div className="header-spacer" />
      <span className={`mode-badge ${snapshot?.mode === 'github' ? 'mode-live' : ''}`}>{snapshot?.mode === 'github' ? 'Live repository' : 'Demo workspace'}</span>
      <button aria-label="AI + Jev grouping" className="button ai-button" onClick={() => setDialog('grouping')} data-testid="grouping-controls"><DesignIcon name="0-imgIconSpark" size={15} /><span>AI + Jev</span></button>
      <button className="button save-button" onClick={() => void saveView()}>Save view</button>
      <button className="avatar" onClick={() => setDialog('help')} aria-label="Help and keyboard shortcuts"><CircleHelp size={16} /></button>
    </header>
    <main id="graph-workspace" className={`graph-workspace ${selectedFile ? 'has-inspector' : ''}`} data-testid="graph-viewport">
      {presentationSnapshot && <ConstellationGraph {...{ overviewRequest }} snapshot={presentationSnapshot} selectedSourceIds={selectedIds} selectedFileId={selectedFileId} onSelectFile={chooseFile} focusGroupId={focusGroupId} onFocusGroup={focusIsland} searchQuery={query} showImports={showImports} onLayoutReady={setActiveLayout} onOpenFiles={() => setDialog('list')} {...{ initialCamera, onCameraChange: (camera: SharedCamera) => { viewCamera.current = camera; if (performance.now() - lastCameraWrite.current > 200) { lastCameraWrite.current = performance.now(); history.replaceState(null, '', `${location.pathname}?${sharedViewQuery(location.search, snapshot!, kind, selectedIds, selectedFileId || pendingSharedFile.current, camera)}`); } } }} />}
      {!snapshot && <div className="empty-workspace"><LoaderCircle className="spinning" size={24} /><h1>Opening your constellation</h1><p>Finding the shape of your repository.</p>{error && <><p className="error-text">{error}</p><button className="button" onClick={() => void loadDemo()}>Try again</button></>}</div>}
      {snapshot && <>
        <div className="source-bar panel" data-node-id="17:3072">
          <button className="button source-mode" onClick={() => setDialog('sources')}><span>{kind === 'pr' ? 'Pull requests' : 'Commits'}</span><DesignIcon name="1-imgIconChevron" size={12} /></button>
          <div className="source-chips">{selectedSources.slice(0, 4).map(source => <button key={source.id} className="source-chip" aria-label={`Remove ${displayLabel(source)}`} onClick={() => toggleSource(source.id)}>{displayLabel(source)}<DesignIcon name="1-imgIconClose" size={11} /></button>)}{selectedSources.length > 4 && <span className="muted small">+{selectedSources.length - 4}</span>}</div>
          <span className="selection-count">{selectedIds.length} selected</span><span className="flex-spacer" />
          <button aria-label="Edit selection" className="button edit-selection" onClick={() => setDialog('sources')} data-testid="source-selector"><DesignIcon name="1-imgIconPlus" size={15} /><span>Edit selection</span></button>
        </div>
        <div className="graph-search panel" data-node-id="17:3095"><DesignIcon name="2-imgIconSearch" size={16} /><input ref={searchRef} type="search" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { if (matchingFiles[0]) chooseFile(matchingFiles[0].id); else if (matchingGroups[0]) focusIsland(matchingGroups[0].id); } }} aria-label="Find a file, folder or island" placeholder="Find a file, folder or island…" data-testid="file-search" /><kbd>/</kbd>
          {query && <div className="search-results panel" role="listbox" aria-label="Search results">{matchingGroups.map(group => <button key={group.id} role="option" aria-selected="false" onClick={() => focusIsland(group.id)}><Layers3 size={15} /><span>{group.label}<small>Island · {presentationSnapshot?.nodes.filter(node => node.groupId === group.id).length} files</small></span><ArrowRight size={14} /></button>)}{matchingFiles.map(node => <button key={node.id} role="option" aria-selected={node.id === selectedFileId} onClick={() => chooseFile(node.id)}><FileCode2 size={15} /><span>{basename(node.path)}<small>{node.path}</small><small>{groupBreadcrumb(snapshot.groups, node.groupId)}</small></span><ArrowRight size={14} /></button>)}{!matchingFiles.length && !matchingGroups.length && <p className="search-empty">No files or islands match “{query}”.</p>}</div>}
        </div>
        <div className="graph-heading" data-node-id="17:3102"><h1>Change constellation</h1><p><span data-testid="changed-count">{selectionPhase === 'ready' ? changedNodes.length : '—'}</span> affected files<span className="dot-separator">·</span>{selectionPhase === 'ready' ? affectedIslands : '—'} islands<span className="dot-separator">·</span><span data-testid="overlap-count">{selectionPhase === 'ready' ? overlapCount : '—'}</span> overlapping</p>{selectionPhase !== 'ready' && <p className="selection-state-note" role="status">{selectionPhase === 'loading' ? 'Updating footprint · highlights are provisional' : 'Selection unavailable · retry or choose other changes'}</p>}<div className="context-line" title={`Context snapshot ${snapshot.contextSha}`}><GitCommitHorizontal size={12} /><span>{snapshot.contextRef}</span><code>{snapshot.contextSha.slice(0, 7)}</code>{snapshot.mode === 'demo' && <span className="demo-label">synthetic data</span>}</div></div>
        <div className="graph-view-controls" data-node-id="17:3105"><div className="group-menu-wrapper"><button className="button" onClick={() => setGroupMenu(!groupMenu)} aria-expanded={groupMenu}><DesignIcon name="4-imgIconSpark" size={15} />Islands: {groupLevel}<DesignIcon name="4-imgIconChevron" size={12} /></button>{groupMenu && <div className="group-level-menu panel">{(['Modules', 'Folders', 'Components'] as GroupLevel[]).map(level => <button key={level} onClick={() => { setGroupLevel(level); setFocusGroupId(null); setGroupMenu(false); }}><span>{level}</span>{level === groupLevel && <Check size={14} />}</button>)}</div>}</div><button className={`button imports-toggle ${showImports ? 'is-active' : ''}`} onClick={() => setShowImports(!showImports)} aria-pressed={showImports}>Imports<DesignIcon name="4-imgIconChevron" size={12} /></button><button className="button icon-button" aria-label="Open file list" data-testid="accessible-list-toggle" onClick={event => { event.currentTarget.focus(); setDialog('list'); }}><DesignIcon name="4-imgIconSliders" size={15} /></button></div>
        {focusGroup && <div className="focus-breadcrumb"><button onClick={() => focusIsland(null)}><ArrowLeft size={12} />All islands</button><span>/</span><strong>{focusGroup.label}</strong><button className="text-button" onClick={() => explainGroup(focusGroup.id)}>Why this group?</button></div>}
        {snapshot.coverage.status !== 'complete' && <div className="coverage-notice panel" role="status"><ShieldCheck size={15} /><span>{snapshot.coverage.status === 'partial' ? 'Partial analysis' : 'Analysis coverage'}<small>{snapshot.coverage.reasons[0] || 'Some dependency information is unavailable.'}</small></span><button className="text-button" onClick={() => setDialog('help')}>Details</button></div>}
        {!selectedIds.length && <div className="zero-selection panel"><GitPullRequest size={20} /><div><strong>Your repository, at a glance</strong><p>Select PRs or commits to highlight the files they touch.</p></div><button className="button accent" onClick={() => setDialog('sources')}>Select changes</button></div>}
        <button className="organization-hint panel" data-node-id="17:3170" onClick={() => setDialog('grouping')}><span><DesignIcon name="6-imgIconSpark" size={14} /><strong>{snapshot.groups.some(group => group.origin === 'ai') ? 'AI + Jev grouping' : snapshot.groups.some(group => group.origin === 'manual') ? 'Your custom grouping' : 'Organized by modules'}</strong></span><small>Select an island to explore its files</small></button>
        <GraphLegend sourceKind={kind} fileCount={snapshot.nodes.length} />
        {selectedFile && <FileInspector key={selectedFile.id} onExplainGroup={() => explainGroup(selectedFile.groupId)} snapshot={snapshot} file={selectedFile} selectedSources={selectedSources} closeRef={inspectorCloseRef} onClose={() => chooseFile(null)} onBack={() => { chooseFile(null); setFocusGroupId(null); setOverviewRequest(value => value + 1); }} onSelectFile={chooseFile} onFocusGroup={() => focusIsland(presentationSnapshot?.nodes.find(node => node.id === selectedFile.id)?.groupId || selectedFile.groupId)} organizeControls={<details className="move-file"><summary>Organize this file</summary><label>Primary island<select value={moveGroup || selectedFile.groupId} onChange={event => setMoveGroup(event.target.value)}>{snapshot.groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</select></label><button className="button" disabled={!moveGroup || moveGroup === selectedFile.groupId || !!busy} onClick={() => void mutateGrouping({ type: 'move', fileIds: [selectedFile.id], groupId: moveGroup })}>Move file</button></details>} />}
      </>}
      {busy && <div className="activity-indicator panel" role="status"><LoaderCircle size={15} className="spinning" /><span>{busy}</span>{(abortRef.current || selectionAbortRef.current) && <button className="text-button" onClick={cancelAnalysis}>Cancel</button>}</div>}
      {error && snapshot && <div className="error-banner panel" role="alert"><CircleHelp size={17} /><span>{error}</span>{selectionPhase === 'failed' && <button className="text-button" onClick={() => void updateSelection(selectedIds, kind)}>Retry selection</button>}{snapshot.mode === 'github' && <button className="text-button" onClick={() => void analyzeTarget(snapshot.repository.fullName, snapshot.contextSha)}>Refresh analysis</button>}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
      {notice && <div className="toast panel" role="status"><CheckCheck size={16} />{notice}</div>}
      {snapshot && <ReviewAnnouncements busy={!!busy} changedFiles={changedNodes.length} overlapFiles={overlapCount} selectedPath={selectedFile?.path} sourceCount={selectedIds.length} coverage={snapshot.coverage.status} />}
    </main>
    {dialog === 'sources' && snapshot && <Modal title="Choose your changes" eyebrow="COMPARE A FOOTPRINT" onClose={() => setDialog(null)}><p className="modal-intro">Select several changes to see where they meet. PR and commit selections are remembered separately.</p><div className="segmented-control"><button data-testid="source-mode-pr" className={kind === 'pr' ? 'selected' : ''} onClick={() => switchKind('pr')}><GitPullRequest size={15} />Pull requests</button><button data-testid="source-mode-commit" className={kind === 'commit' ? 'selected' : ''} onClick={() => switchKind('commit')}><GitCommitHorizontal size={15} />Commits</button></div><div className="modal-search"><Search size={16} /><input type="search" aria-label="Filter changes" placeholder={kind === 'pr' ? 'Search pull requests…' : 'Search commits…'} value={sourceQuery} onChange={event => setSourceQuery(event.target.value)} /></div><fieldset className="source-list"><legend className="sr-only">Select {kind === 'pr' ? 'pull requests' : 'commits'}</legend>{sources.filter(source => `${source.label} ${source.title}`.toLowerCase().includes(sourceQuery.toLowerCase())).map(source => <label className={`source-option ${selectedSet.has(source.id) ? 'checked' : ''}`} key={source.id}><input type="checkbox" checked={selectedSet.has(source.id)} onChange={() => toggleSource(source.id)} disabled={!selectedSet.has(source.id) && selectedIds.length >= MAX_SELECTED_SOURCES} data-testid={`source-${source.id}`} /><span className="source-option-icon">{kind === 'pr' ? <GitPullRequest size={17} /> : <GitCommitHorizontal size={17} />}</span><span className="source-option-body"><strong>{source.title}</strong><small><code>{displayLabel(source)}</code><span>·</span>{source.loaded === false ? 'Not yet analyzed' : `${source.files.length} files`}<span>·</span>{source.comparisonKind === 'first-parent' ? 'First-parent delta' : kind === 'pr' ? 'Pull request footprint' : 'Commit footprint'}</small></span></label>)}{!!sources.length && !sources.some(source => `${source.label} ${source.title}`.toLowerCase().includes(sourceQuery.toLowerCase())) && <div className="empty-list"><p>No loaded changes match this search.</p><small>Clear the search or load more changes.</small></div>}{!sources.length && <div className="empty-list"><GitPullRequest size={24} /><p>No {kind === 'pr' ? 'pull requests' : 'commits'} are available in this snapshot.</p><small>Try another repository or refresh the analysis.</small></div>}</fieldset>{snapshot.mode === 'github' && nextSourcePage && <button className="button load-more-sources" disabled={loadingSources} onClick={() => void loadMoreSources()}>{loadingSources ? <LoaderCircle size={14} className="spinning" /> : <RefreshCw size={14} />}Load more changes</button>}{error && <p className="form-error" role="alert">{error}</p>}<div className="selection-summary"><span>{selectedIds.length} / {MAX_SELECTED_SOURCES} selected</span><span>{selectionPhase === 'ready' ? `${changedNodes.length} unique files · ${overlapCount} overlapping` : selectionPhase === 'loading' ? 'Updating footprint…' : 'Footprint unavailable'}</span></div><p className="inline-note">{kind === 'pr' ? 'Each PR is compared to its own pinned base. This view does not simulate a merge.' : 'Each commit is compared to its first parent. Reverted edits remain part of the touched-file footprint.'}</p><div className="modal-footer"><button className="text-button" onClick={() => void updateSelection([])}>Clear selection</button><button className="button accent" onClick={() => setDialog(null)}>Explore changes<ArrowRight size={14} /></button></div></Modal>}
    {dialog === 'repository' && <Modal title="Choose a repository" eyebrow="YOUR CODE, IN CONTEXT" onClose={() => setDialog(null)}><p className="modal-intro">Explore a public repository, or sign in to select repositories shared with the GitHub App.</p><GitHubAccount onSelect={setRepoInput} onDisconnected={() => void loadDemo()} /><form onSubmit={event => void connectRepository(event)}><label className="form-label">Repository<input autoFocus placeholder="owner/repository or GitHub URL" value={repoInput} onChange={event => setRepoInput(event.target.value)} required /></label><label className="form-label">Context branch or commit <span>optional</span><input placeholder="Default branch HEAD" value={contextInput} onChange={event => setContextInput(event.target.value)} /></label><p className="inline-note"><ShieldCheck size={14} />Read-only analysis. Repository code is never executed.</p>{error && <p className="form-error" role="alert">{error}</p>}<button className="button accent full-width" type="submit" disabled={!!busy}>{busy ? <LoaderCircle size={15} className="spinning" /> : <FolderGit2 size={16} />}{busy || 'Map repository'}</button>{abortRef.current && <button className="text-button full-width" type="button" onClick={cancelAnalysis}>Cancel analysis</button>}</form><div className="or-divider"><span>or explore the sample</span></div><button className="demo-repo-card" onClick={() => void loadDemo()}><span className="demo-repo-icon"><FolderGit2 size={22} /></span><span><strong>acme / atlas</strong><small>212 files · 6 islands · sample PRs and commits</small></span><ArrowRight size={17} /></button>{snapshot?.mode === 'github' && <button className="text-button disconnect-button" onClick={() => void loadDemo()}><Unplug size={14} />Disconnect and return to demo</button>}<p className="subtle small">{config.github?.configuredToken ? 'Server GitHub credentials are configured.' : 'Public repository analysis is available. Private access requires a configured GitHub App.'}</p></Modal>}
    {dialog === 'grouping' && snapshot && <Modal title="Make sense of the islands" eyebrow="AI + JEV GROUPING" onClose={() => setDialog(null)} wide><GroupingReview snapshot={snapshot} presentationSnapshot={presentationSnapshot} proposal={proposal} revision={groupingRevision} busy={!!busy || groupingLoading} error={error} hasUndo={hasUndo} persistence={config.ai?.persistence} available={config.ai?.available} configured={config.ai?.configured} evaluation={config.ai?.evaluation} availabilityMessage={config.ai?.message} explainedGroupId={explainedGroupId} activeLayout={activeLayout} onExplain={setExplainedGroupId} onRequest={() => void requestGrouping()} onUndo={() => void undoGrouping()} onApply={() => void applyProposal()} onReject={() => void rejectProposal()} onReload={() => void reloadGrouping()} onMutate={operation => void mutateGrouping(operation)} /><div className="modal-footer"><span className="subtle small">{groupingSource(snapshot, groupingRevision)}</span><button className="button" onClick={() => setDialog(null)}>Done</button></div></Modal>}
    {dialog === 'list' && presentationSnapshot && <Modal title="Files in your constellation" eyebrow="ACCESSIBLE FILE EXPLORER" onClose={() => setDialog(null)} wide><FileList snapshot={presentationSnapshot} selectedSourceIds={selectedIds} query={listQuery} onQueryChange={setListQuery} onInspect={id => { chooseFile(id); fileFocusRef.current = document.querySelector<HTMLButtonElement>('[data-testid="accessible-list-toggle"]'); setDialog(null); }} onFocusIsland={id => { focusIsland(id); setDialog(null); }} /><div className="modal-footer"><span className="muted small">Import connections are review context.</span><button className="button" onClick={() => setDialog(null)}>Back to graph</button></div></Modal>}
    {dialog === 'help' && <Modal title="Explore the constellation" eyebrow="A MAP FOR CODE REVIEW" onClose={() => setDialog(null)}><p className="modal-intro">Each circle is a file. Islands reveal your code structure. Select several changes to see their shared footprint.</p><dl className="shortcut-list"><div><dt>Find a file or island</dt><dd><kbd>/</kbd></dd></div><div><dt>Pan the map</dt><dd>Drag or arrow keys</dd></div><div><dt>Zoom in and out</dt><dd>Scroll, pinch, or + / −</dd></div><div><dt>Close details</dt><dd><kbd>Esc</kbd></dd></div><div><dt>Review without the canvas</dt><dd>Open file list</dd></div></dl>{snapshot && <section className="coverage-details"><h3>Analysis coverage: {snapshot.coverage.status}</h3>{snapshot.coverage.reasons.length ? <ul>{snapshot.coverage.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : <p>All files in this snapshot are represented. Imports describe static code relationships.</p>}<p>Imports suggest review context. They do not establish runtime breakage. File overlap does not establish a merge conflict.</p></section>}<div className="modal-footer"><button className="text-button" onClick={() => setDialog('list')}><List size={15} />Open file list</button><button className="button accent" onClick={() => setDialog(null)}>Start exploring</button></div></Modal>}
  </div>;
}
