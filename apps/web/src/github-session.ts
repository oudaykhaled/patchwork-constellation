/** The browser receives a CSRF nonce and account summary, never GitHub credentials. */
export type AccountSession = { configured: boolean; authenticated: boolean; login?: string; csrf?: string; expiresAt?: number };
export async function accountSession(signal?: AbortSignal): Promise<AccountSession> {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('Account status is unavailable. Retry shortly.');
  return response.json() as Promise<AccountSession>;
}
export async function authenticatedFetch(path: string, options: RequestInit = {}) {
  if (!path.startsWith('/api/') || path.includes('\\')) throw new Error('Use a same-origin application API path.');
  const headers = new Headers(options.headers);
  if (!['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase())) {
    const session = await accountSession(options.signal ?? undefined);
    if (session.configured && session.authenticated && session.csrf) headers.set('X-CSRF-Token', session.csrf);
  }
  return fetch(path, { ...options, headers, credentials: 'same-origin' });
}
