/** Public diagnostics are selected from constants, never copied from provider/DB/source errors. */
const messages: Readonly<Record<string, string>> = Object.freeze({
  VALIDATION: 'The request is invalid. Check the selected values and retry.',
  INVALID_REPOSITORY: 'Enter a valid https://github.com/owner/repository address.',
  INVALID_SOURCE_PATH: 'The repository contains an unsupported or unsafe file path.',
  INVALID_API_PATH: 'The requested repository resource is invalid.',
  INVALID_REF: 'Select a valid immutable repository revision.',
  INVALID_SOURCE: 'The selected change source is invalid. Refresh the source list.',
  INVALID_PAGINATION: 'The requested page is invalid.',
  UNKNOWN_SOURCE: 'A selected change source is unavailable. Refresh the source list.',
  SELECTION_LIMIT: 'Select at most 20 changes at once.',
  STALE_SOURCE: 'A selected change moved. Refresh the repository and retry.',
  STALE_VERSION: 'Analysis changed. Reload the current analysis before continuing.',
  SUPERSEDED: 'This request was superseded. Retry the latest selection.',
  RATE_LIMITED: 'The service is rate limited. Retry after the indicated delay.',
  QUEUE_FULL: 'The request queue is full. Retry shortly.',
  BUSY: 'Analysis capacity is busy. Retry shortly.',
  RESPONSE_LIMIT: 'Repository data exceeds the configured response budget.',
  SOURCE_UNAVAILABLE: 'Source content is unavailable at the pinned revision.',
  NOT_FOUND: 'The repository or revision is unavailable. Check its name and access.',
  ACCESS_DENIED: 'Access is not authorized. Reconnect GitHub or select another repository.',
  PRIVATE_UNSUPPORTED: 'Private repositories require a configured GitHub App connection.',
  AUTH_FAILED: 'The server GitHub credential is invalid or expired.',
  SIGN_IN_REQUIRED: 'Sign in with GitHub to access repository analysis.',
  AUTH_SESSION_REQUIRED: 'Reconnect GitHub before retrying this stored analysis.',
  AUTH_REVOKED: 'GitHub authorization expired. Sign in again.',
  ACCESS_REMOVED: 'Repository access was removed. Reconnect GitHub.',
  REPOSITORY_DENIED: 'Repository access is unavailable. Reconnect and choose an accessible repository.',
  SNAPSHOT_NOT_FOUND: 'This snapshot is unavailable in your account. Analyze the repository again.',
  JOB_NOT_FOUND: 'This analysis job is unavailable in your account.',
  CSRF_DENIED: 'Refresh the page and retry this action.',
  OAUTH_STATE: 'Sign-in expired or did not match. Start sign-in again.',
  OAUTH_FAILED: 'GitHub sign-in failed. Start sign-in again.',
  AUTH_BUSY: 'Sign-in capacity is busy. Retry shortly.',
  AUTH_DISCOVERY_LIMIT: 'Repository discovery exceeds capacity. Narrow the App installation.',
  AUTH_RESPONSE_LIMIT: 'GitHub authorization data exceeds the response budget.',
  AUTH_UNAVAILABLE: 'GitHub authorization is unavailable. Reconnect or retry shortly.',
  INVALID_AUTH_RESPONSE: 'GitHub returned invalid authorization data. Reconnect or retry.',
  REVISION_CONFLICT: 'Grouping changed. Reload the current revision before editing.',
  STORAGE_BUSY: 'Another process is saving grouping. Reload and retry.',
  STORAGE_ERROR: 'Grouping could not be saved. The previous revision is retained.',
  STORAGE_FAILED: 'Analysis state could not be saved. Check storage and retry.',
  INVALID_OPERATION: 'The grouping operation is invalid. Reload and retry.',
  INVALID_OUTPUT: 'The model returned an invalid proposal. The current grouping is retained.',
  BUDGET_EXCEEDED: 'The AI request budget is exhausted. The current grouping is retained.',
  ABORTED: 'The request was cancelled.',
  NETWORK_ERROR: 'The external service could not be reached. Retry shortly.',
  ANALYSIS_TIMEOUT: 'Analysis exceeded its resource budget. Retry a smaller repository.',
  GIT_FALLBACK_LIMIT: 'The pinned Git comparison exceeded its resource budget. Partial coverage is retained.',
  GIT_FALLBACK_UNAVAILABLE: 'Git comparison is unavailable on this host. Partial coverage is retained.',
  GIT_FALLBACK_FAILED: 'The pinned Git comparison failed. Partial coverage is retained.',
  INVALID_RESPONSE: 'The external service returned invalid data. Retry shortly.',
});

export function publicErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'ZodError') return 'VALIDATION';
  const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'REQUEST_FAILED';
}

export function publicErrorMessage(error: unknown): string {
  const message = messages[publicErrorCode(error)];
  if (message) return message;
  const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500;
  if (status === 400 || status === 422) return 'The request is invalid. Check the selected values and retry.';
  if (status === 401 || status === 403) return 'This action is not authorized. Reconnect and retry.';
  if (status === 404) return 'The requested analysis is unavailable. Analyze the repository again.';
  if (status === 409) return 'The analysis changed. Reload the current view and retry.';
  if (status === 413) return 'The request exceeds the configured size budget.';
  if (status === 415) return 'Use an application/json request.';
  if (status === 429) return 'The service is busy. Retry after the indicated delay.';
  return 'The request could not be completed. Retry or check the configured service.';
}

export const PRODUCTION_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'";
