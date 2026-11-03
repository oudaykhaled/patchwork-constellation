# Verified refresh delivery

The webhook endpoint is `POST /api/webhooks/github`. It is disabled with HTTP 503 until a `WebhookRefreshService` with a durable inbox and authorized installation routing is supplied to `createApplicationServer`. No subscription, secret, public endpoint or GitHub App installation is created by running the demo.

Configure the App for `push`, `pull_request`, `installation` and `installation_repositories` events only. Set a high-entropy `GITHUB_WEBHOOK_SECRET` server-side and use PostgreSQL. `createConfiguredWebhookRefresh` creates the PostgreSQL inbox when the secret is present; a configured database failure never falls back to memory. Apply `database/migrations/002_webhook_inbox.sql` with a migration principal before serving with a restricted principal. The factory runs this idempotent migration for local setup; `createPostgresWebhookInbox({autoMigrate:false})` supports pre-migrated serving deployments.

The server adapter must supply these hooks:

| Hook | Required authority and behavior |
| --- | --- |
| `resolveInstallation(id)` | Return only server-known bindings from earlier live user/App intersection checks, including numeric repository ID and owner scope. A signed payload name does not create an owner binding. Unknown installations return no bindings. |
| `resolveScope(scope)` | Revalidate current access and return its known numeric installation/repository binding. Disconnected/revoked sessions fail closed. |
| `enqueueRefresh(task)` | Reauthorize through `credentialsForOwner`, invalidate mutable metadata, call `pinAnalysisInput` for the current default/display ref, then `AnalysisJobs.submit(scope,input)`. Do not persist tokens or use event head SHA as authority. Source-only changes may reuse the pinned context while refetching footprints. |
| `invalidateMetadata(repository)` | Call `invalidateGitHubRepositoryCache` so mutable PR/ref metadata is reconciled; immutable SHA caches remain valid. |
| `invalidateAuthorization(installationId,repositoryId?)` | Invalidate token/routing caches immediately. Capture known scopes before invalidation. Every subsequent result read still checks live authorization. |
| `purgeRepository(scope)` | Fence/cancel analysis, source and grouping writes for that owner/repository **before** deleting snapshots/jobs/grouping history. Deleting rows alone is insufficient because a late worker can recreate them. |

The current auth routing hints are bounded process memory. After restart, users must reconnect/reconcile to restore live-authorized bindings; a delivery never grants access to a previously unknown user. A hosted deployment needing offline multi-user refresh requires durable installation/account bindings, independent current authorization, and the same purge fence.

Ingress validates HMAC SHA-256 over the exact raw bytes with constant-time comparison before JSON processing. It bounds the body to 1 MiB and accepts only the supported events. Delivery ID and sanitized refresh/revocation tasks are inserted atomically before HTTP 202. Raw payloads, commit messages, source text and credentials are not stored in this inbox. The event body supplies numeric routing hints only; both repository ID and name must match a known binding for ordinary updates.

The inbox holds at most 10,000 delivery records, retained for seven days; its transaction serializes capacity checks across processes. Completed records are retained for deduplication. A full inbox returns a recoverable error for GitHub redelivery. Work leases last 60 seconds and renew every 20 seconds. Retries back off from one second to five minutes and stop after ten attempts. Terminal failed deliveries require redelivery with a new administrative reconciliation or the explicit reconcile action; inspect aggregate database status counts, not raw payload logs. Out-of-order push, force-push and PR base/synchronize events resolve current repository refs rather than applying event SHAs backward. Conservative delayed removals invalidate caches and require current access to be checked again; a later authorized reconcile clears the revocation notice.

`GET /api/refresh?repository=owner/name` exposes owner-scoped refresh metadata, with normal browser authentication and authorization. The UI reads it at a 30-second interval only while visible, and on visibility restoration. The current graph remains immutable until **Apply refresh** is chosen. Surviving selected-file/island IDs and selected source IDs are retained. **Check for updates** calls `POST /api/refresh/reconcile`, which reauthorizes and resolves current refs even if a webhook was missed. A refresh outage preserves the existing graph.

Run `pnpm exec vitest run apps/web/webhook-refresh.test.ts tests/api/webhooks.test.ts packages/storage/src/webhook-postgres.test.ts` for signature/routing/replay/force-push/revocation/recovery checks. Set `TEST_DATABASE_URL` to an authorized disposable PostgreSQL database for the durable restart test. `tests/e2e/webhook-refresh.spec.ts` covers explicit apply, surviving file/source state and revoked-access reconciliation with controlled API fixtures. Actual App delivery, live PostgreSQL, source-incremental efficiency, cross-process restart and merged graph pin preservation still require the integrated staging evidence recorded in issue #20.

Primary API references checked 2026-11-03: [GitHub signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [event actions and delivery identifiers](https://docs.github.com/en/webhooks/webhook-events-and-payloads).
