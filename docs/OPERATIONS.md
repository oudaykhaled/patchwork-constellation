# Analysis operations

Use this runbook with the scoped, read-only GitHub App configuration in [GITHUB_APP.md](GITHUB_APP.md), the storage instructions in [STORAGE.md](STORAGE.md), and the [release evidence](evidence/data-09.json). Local-public mode has one local owner; it is not a multi-user deployment.

## Restore an interrupted job

1. Check `/api/health`, `/api/health/worker` and the configured storage kind in `/api/config`. A configured database failure must remain an error, rather than falling back to volatile memory. Fix configuration before resubmitting work.
2. Reconnect the authorized account and poll `GET /api/jobs/:id?repository=owner/repository&includeSnapshot=false`. Keep the repository and original pinned context SHA. An immutable result is never replaced by resolving the branch again during recovery.
3. A durable job may be recovered after its worker lease expires, within its bounded attempt policy. A graceful shutdown requeues interrupted work. Recovery redoes analysis of the pinned snapshot; it does not resume an in-memory parser halfway through a file. An old lease cannot publish a result after cancellation or a new lease.
4. `AUTH_SESSION_REQUIRED`, removed repository access or revoked installation must stop recovery. Reconnect and explicitly retry after authorization has been restored. Never edit a job owner, installation ID or token in the database to bypass access checks.
5. If a job reaches its attempt limit, retain its sanitized code, stage and correlation ID; fix the cause and explicitly resubmit. A failure message must not include credentials or source text. Do not clear all users' caches to recover one repository.

No PostgreSQL process-kill/restart or live private-account rehearsal was available during this change. Run those in an isolated staging scope before beta; the memory-store tests establish logic, not operational database availability.

## Rate exhaustion and source drift

Respect GitHub's `Retry-After` or quota reset. Short waits may retry within the gateway's bounded budget; a longer wait returns recoverable rate guidance. Avoid loops that refresh the entire tree, source picker and all selected footprints at once. The gateway deduplicates work and serializes within its credential scope; it is not a distributed installation quota service.

Source discovery is separate from footprint loading. Retain already-pinned source pairs while a retry is pending. `STALE_SOURCE` means the PR base/head changed during discovery or loading: tell the user to refresh explicitly and review the new source version. Never silently combine the old file list with a new head SHA. A GitHub API cap requires a bounded Git fallback or an explicit partial result; another comparison page does not provide more comparison files.

## Failed webhook delivery or missed update

The configured ingress is `POST /api/webhooks/github`; unconfigured ingress must reject the request. A successful response means the delivery identity and sanitized refresh work were accepted in the durable inbox, not that analysis is complete. Verify the HMAC against the original raw bytes. Changing whitespace changes the signature. Do not forge a replacement payload or bypass verification during replay.

Use GitHub's redelivery for the same delivery ID after a temporary service outage. Durable deduplication makes repeated deliveries safe. The worker resolves current authorized refs instead of applying the event SHA, so out-of-order events cannot roll the graph backward. Record delivery ID/outcome only, not its source-bearing payload. Inspect the bounded retry state and queue health; repair storage or account authorization before replaying repeatedly.

If a delivery was missed, use the application's explicit reconcile/refresh action. Refresh reports that a new analysis is available; the existing review graph remains fixed until the user applies it. Confirm surviving file IDs/focus after apply. Removal events invalidate authorization before background scoped purge; every subsequent result request still reauthorizes. Account disconnect immediately removes session authority. Check scoped deletion/retention separately instead of assuming disconnect itself deletes every stored object.

## Review a partial graph

Always retain `coverage.status`, reasons, parser limits and per-file coverage alongside metadata and every chunk. Unsupported languages, unresolved imports, generated/vendor exclusions, symlinks, submodules, malformed source, large blobs and caps are independent reasons for missing edges. An absent edge is not proof that no dependency exists. A source-head dependency layer is scoped separately from pinned context edges and may be partial.

Request `/api/graphs/:id?repository=owner/repository` for counts, groups and the graph version. Page nodes before global edges using `/chunks?kind=nodes|edges|groups&version=...`; use each returned cursor with the same kind/group scope. Nodes and edges have independent pages. An edge may refer to a node from an earlier node page. Group-filtered edges are closed over that group's nodes and report excluded cross-group edges. On `409 STALE_VERSION`, discard the accumulated pages and restart from metadata; mixing revisions can create false counts or dangling edges.

Do not infer full repository size from the number of returned rows. Show exact represented counts, known total counts where available, and every stated cap. `413 PAYLOAD_LIMIT` means an individual item/detail is too large for the response budget; use supported paging or narrower scope. It does not authorize truncating fields silently.

## Retention, removal and incident triage

Snapshots contain paths, source membership and evidence metadata; the tested store does not retain full fetched source blobs in snapshot payloads. Gateway caches can retain fetched blob text temporarily, so treat both memory and storage as repository data. Scope removal and cache invalidation must use the verified owner/repository binding. Preserve unaffected owners. Run retention pruning and verify expired snapshots, jobs and replay identities become unavailable.

For an unexplained count difference, block beta. Record fixture seed or immutable refs, algorithm/schema version, selected sources, coverage reasons and exact expected/observed sets. Reproduce with `pnpm exec vitest run tests/backend-release` and the authored Git history generator. For an isolation failure, disable the affected authenticated route/provider rather than relying on UI hiding. Imported repositories are data: do not install their dependencies, run scripts/hooks, follow submodules/symlinks, or extract an archive as a workaround. Archive ingestion is currently absent and must receive its own traversal/security review if added.

## Reproduce evidence

```sh
pnpm exec vitest run tests/backend-release
pnpm exec tsx tests/backend-release/measure.ts docs/evidence/data-09.json
```

The report records actual hardware/runtime, fixture seed, controlled-service conditions and timings. It deliberately remains `partial` until the live PostgreSQL/App/removal/webhook and process-containment gates pass. Measurements taken while parallel agents are building are not production capacity claims. Never copy a synthetic success into a staging/live gate.
