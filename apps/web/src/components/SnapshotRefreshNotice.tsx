import { useEffect, useRef, useState } from 'react';
import type { GraphSnapshot } from '@patchwork/contracts';
import './snapshot-refresh.css';

type RefreshState = { revision: number; stale: boolean; revoked: boolean; updatedAt: string; jobId?: string };
type Request = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export function SnapshotRefreshNotice({ snapshot, request, onApply }: { snapshot: GraphSnapshot; request: Request; onApply: (value: GraphSnapshot) => void }) {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<RefreshState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const appliedRevision = useRef(0);
  const action = useRef<AbortController | null>(null);
  useEffect(() => {
    if (snapshot.mode === 'demo') return;
    const controller = new AbortController(); appliedRevision.current = 0; setAvailable(false); setState(undefined); setError('');
    const read = async () => {
      try { const result = await request<{ available: boolean; state?: RefreshState }>(`/api/refresh?repository=${encodeURIComponent(snapshot.repository.fullName)}`, undefined, controller.signal); if (!controller.signal.aborted) { setAvailable(result.available); setState(result.state); } } catch { /* Existing graph stays usable; explicit reconcile exposes actionable errors. */ }
    };
    void read(); const timer = setInterval(() => { if (!document.hidden) void read(); }, 30_000);
    const visibility = () => { if (!document.hidden) void read(); }; document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); action.current?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [snapshot.mode, snapshot.repository.fullName]);
  const pending = state?.stale && state.revision > appliedRevision.current && Date.parse(state.updatedAt) > Date.parse(snapshot.createdAt);
  async function reconcile() {
    action.current?.abort(); const controller = new AbortController(); action.current = controller; setBusy(true); setError('');
    try { const result = await request<{ state: RefreshState }>('/api/refresh/reconcile', { repository: snapshot.repository.fullName, contextRef: snapshot.contextRef }, controller.signal); if (!controller.signal.aborted) setState(result.state); }
    catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function apply() {
    if (!state?.jobId || state.revoked) return;
    action.current?.abort(); const controller = new AbortController(); action.current = controller; setBusy(true); setError('');
    try {
      const deadline = Date.now() + 180_000;
      while (!controller.signal.aborted && Date.now() < deadline) {
        const job = await request<{ status: string; snapshot?: GraphSnapshot; error?: string }>(`/api/jobs/${encodeURIComponent(state.jobId)}?repository=${encodeURIComponent(snapshot.repository.fullName)}`, undefined, controller.signal);
        if (job.snapshot && ['ready', 'partial'].includes(job.status)) { appliedRevision.current = state.revision; onApply(job.snapshot); return; }
        if (['failed', 'cancelled'].includes(job.status)) throw new Error(job.error || 'Refresh did not complete. Check for updates to retry.');
        await new Promise<void>((resolve, reject) => { const stop = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); }; const timer = setTimeout(() => { controller.signal.removeEventListener('abort', stop); resolve(); }, 1000); controller.signal.addEventListener('abort', stop, { once: true }); });
      }
      if (!controller.signal.aborted) throw new Error('Refresh is still running. Your current map is preserved; try Apply again.');
    } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  if (!available || snapshot.mode === 'demo') return null;
  return <aside className="snapshot-refresh panel" aria-label="Repository updates">
    <span role="status">{pending ? state.revoked ? 'Repository access changed. Reconnect to verify access.' : 'New analysis available. Your current map is preserved.' : 'Watching repository updates'}</span>
    {pending && state?.jobId && !state.revoked && <button className="text-button" disabled={busy} onClick={() => void apply()}>Apply refresh</button>}
    <button className="text-button" disabled={busy} onClick={() => void reconcile()}>{busy ? 'Checking…' : 'Check for updates'}</button>
    {busy && <button className="text-button" onClick={() => { action.current?.abort(); setBusy(false); }}>Stop waiting</button>}
    {error && <span className="error-text" role="alert">{error}</span>}
  </aside>;
}
