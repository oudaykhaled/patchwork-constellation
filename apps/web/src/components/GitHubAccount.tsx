import { useEffect, useState } from 'react';
import { accountSession, authenticatedFetch, type AccountSession } from '../github-session';

export function GitHubAccount({ onSelect, onDisconnected }: { onSelect: (repository: string) => void; onDisconnected: () => void }) {
  const [session, setSession] = useState<AccountSession>();
  const [repositories, setRepositories] = useState<{ id: number; full_name: string; private: boolean; installationId: number }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void accountSession(controller.signal).then(async value => {
      setSession(value);
      if (value.authenticated) {
        const response = await authenticatedFetch('/api/auth/repositories', { signal: controller.signal }); const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Repository access is unavailable. Reconnect GitHub.');
        setRepositories(result.repositories);
      }
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'GitHub connection failed.'); });
    return () => controller.abort();
  }, []);
  if (!session?.configured && !error) return null;
  return <section aria-label="GitHub account" className="github-account">
    {session?.authenticated ? <>
      <p className="inline-note">Signed in as <strong>{session.login}</strong>. Only repositories accessible to your account and the App are listed.</p>
      <label className="form-label">Installed repositories<select aria-label="Installed repositories" defaultValue="" onChange={event => onSelect(event.target.value)}><option value="" disabled>Select a repository</option>{repositories.map(repository => <option key={`${repository.installationId}:${repository.id}`} value={repository.full_name}>{repository.full_name}{repository.private ? ' · private' : ''}</option>)}</select></label>
      {!repositories.length && !error && <p className="inline-note">No accessible installed repositories found. Install the App for a selected repository, then reopen this dialog.</p>}
      <button type="button" className="text-button" onClick={() => { void authenticatedFetch('/api/auth/disconnect', { method: 'POST' }).then(async response => { if (!response.ok) throw new Error('Could not disconnect. Retry shortly.'); setSession({ configured: true, authenticated: false }); setRepositories([]); onDisconnected(); }).catch(reason => setError(String(reason.message))); }}>Sign out of GitHub</button>
    </> : <a className="button" href="/api/auth/login">Sign in with GitHub</a>}
    {error && <p className="form-error" role="alert">{error} <a href="/api/auth/login">Reconnect GitHub</a></p>}
  </section>;
}
