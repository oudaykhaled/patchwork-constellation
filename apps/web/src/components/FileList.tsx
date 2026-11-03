import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { GraphSnapshot } from '@patchwork/contracts';
import { FILE_LIST_WINDOW, fileListRows, fileListWindow } from './file-list-model';
import './file-list.css';

export function FileList({ snapshot, selectedSourceIds, query, onQueryChange, onInspect, onFocusIsland }: {
  snapshot: GraphSnapshot; selectedSourceIds: readonly string[]; query: string;
  onQueryChange: (query: string) => void; onInspect: (id: string) => void;
  onFocusIsland: (id: string) => void;
}) {
  const [groupId, setGroupId] = useState('');
  const [state, setState] = useState('all');
  const [requestedPage, setPage] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const rows = useMemo(() => fileListRows(snapshot, selectedSourceIds), [snapshot, selectedSourceIds]);
  const filtered = useMemo(() => rows.filter(row => row.path.toLowerCase().includes(query.toLowerCase()) &&
    (!groupId || row.groupId === groupId) && (state === 'all' || (state === 'overlap' ? row.sourceCount > 1 : state === 'changed' ? row.sourceCount > 0 : row.sourceCount === 0))), [rows, query, groupId, state]);
  const window = fileListWindow(filtered.length, requestedPage);
  useEffect(() => { setPage(0); }, [query, groupId, state, snapshot.id]);
  useEffect(() => {
    if (pendingFocus.current === null) return;
    listRef.current?.querySelector<HTMLButtonElement>(`[data-row-index="${pendingFocus.current}"]`)?.focus();
    pendingFocus.current = null;
  }, [window.page, filtered]);
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowDown') next++;
    else if (event.key === 'ArrowUp') next--;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = filtered.length - 1;
    else if (event.key === 'PageDown') next += FILE_LIST_WINDOW;
    else if (event.key === 'PageUp') next -= FILE_LIST_WINDOW;
    else return;
    event.preventDefault(); next = Math.max(0, Math.min(filtered.length - 1, next));
    const page = Math.floor(next / FILE_LIST_WINDOW);
    if (page === window.page) listRef.current?.querySelector<HTMLButtonElement>(`[data-row-index="${next}"]`)?.focus();
    else { pendingFocus.current = next; setPage(page); }
  };
  return <section className="file-explorer" aria-label="Files and islands">
    <div className="modal-search"><input type="search" aria-label="Filter file list" placeholder="Filter by file path…" value={query} onChange={event => onQueryChange(event.target.value)} /></div>
    <div className="file-explorer-filters">
      <label>Island<select aria-label="Island" value={groupId} onChange={event => setGroupId(event.target.value)}><option value="">All islands</option>{snapshot.groups.map(group => <option key={group.id} value={group.id}>{group.label} · {rows.filter(row => row.groupId === group.id).length} files</option>)}</select></label>
      <label>Selection status<select aria-label="Selection status" value={state} onChange={event => setState(event.target.value)}><option value="all">All files</option><option value="changed">Directly changed</option><option value="overlap">Multiple selected sources</option><option value="context">Unchanged context</option></select></label>
      {groupId && <button className="button" onClick={() => onFocusIsland(groupId)}>Focus selected island</button>}
    </div>
    <p className="file-explorer-count" role="status" aria-live="polite" aria-atomic="true">{filtered.length ? `Showing files ${window.start + 1}–${window.end} of ${filtered.length} matching files.` : 'No files match these filters.'} {snapshot.nodes.length} files in the snapshot.</p>
    <p className="file-explorer-help" id="file-list-navigation">Results are windowed, never truncated. Use Previous/Next or arrow, Home/End and Page Up/Down keys on a file. Select a file for evidence and connection details.</p>
    <ol className="windowed-file-list" ref={listRef} start={window.start + 1} aria-label="Matching repository files" aria-describedby="file-list-navigation" data-testid="windowed-file-list">
      {filtered.slice(window.start, window.end).map((row, offset) => <li key={row.id} aria-posinset={window.start + offset + 1} aria-setsize={filtered.length}>
        <button data-row-index={window.start + offset} onKeyDown={event => navigate(event, window.start + offset)} onClick={() => onInspect(row.id)}>
          <span className="file-explorer-symbol" aria-hidden="true">{row.sourceCount > 1 ? '◎' : row.sourceCount ? '●' : '○'}</span>
          <span className="file-explorer-row"><strong>{row.path.split('/').pop()}</strong><span className="file-explorer-path">{row.path}</span><span>{row.groupLabel} · {row.sourceCount > 1 ? `Overlap · ${row.sourceCount} sources` : row.sourceCount ? 'Direct change · 1 source' : 'Context · no selected source'}</span><span>{row.statuses.join(', ')} · {row.incoming} incoming / {row.outgoing} outgoing imports</span>{row.sourceLabels.length > 0 && <span>Sources: {row.sourceLabels.join(', ')}</span>}</span>
          <span className="file-explorer-action">Inspect <span aria-hidden="true">→</span></span>
        </button>
      </li>)}
    </ol>
    <nav className="file-explorer-paging" aria-label="File result windows"><button className="button" disabled={window.page === 0} onClick={() => setPage(window.page - 1)}>Previous files</button><span>Window {window.page + 1} of {window.pages}</span><button className="button" disabled={window.page + 1 >= window.pages} onClick={() => setPage(window.page + 1)}>Next files</button></nav>
  </section>;
}
