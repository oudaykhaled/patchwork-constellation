# Supported capability matrix

This matrix describes the working local deterministic preview and code paths being integrated, not an accepted hosted beta. Check the [31-issue acceptance matrix](IMPLEMENTATION_STATUS.md) and each issue report for current verification.

| Capability | Implemented boundary | Release verification |
| --- | --- | --- |
| Graph | File circles, import connections, labeled module/folder/component islands, continuous pan/zoom, semantic DOM controls and list alternative; desktop graph ≥80% | Browser and performance evidence must match release commit; physical touch/GPU/assistive-tech review remains separate |
| Sources | Multiple independent PR footprints or first-parent commit deltas; exact pinned pairs, union and overlap remain distinct | API caps, lineage and bounded fallback evidence: #9/#28 |
| Inventory | Public repository analysis; explicit 2,000-file/120-source/80-KB defaults; larger scopes report partial coverage | No claim of full-repository analysis beyond configured limits |
| Language analysis | Static JS/TS imports, exports and configured resolver support; no repository scripts/dependencies executed | Unsupported languages, unresolved/external imports and parse limits are explicit coverage states |
| Dependency meaning | Observed static imports are review context | No claim of proven runtime impact; source-head layers must retain separate provenance |
| Private access | Read-only GitHub App code path with server credentials and user/installation intersection | Actual App registration, revoked/private/fork access and staging session checks require authorized live evidence |
| Persistence | Bounded volatile local default; optional PostgreSQL and separate grouping override storage | Live migrations, restart, backup/restore and scoped deletion require actual configured service evidence |
| AI/Jev | Separate generative naming and TypeSafe Jev bounded-decision adapters; explicit proposals and manual corrections | No live model quality/latency/cost or provider account/data-terms validation claimed. Missing credentials or failed evaluation preserves deterministic baseline |
| Intelligence release | Disabled in this release workflow | AI-06 must pass independent, reviewed holdout/live gate before a separate intelligence-enabled promotion |
| Hosting | Local Node 24 process on loopback | No cloud deployment, database service, domain, TLS/reverse proxy or hosted beta provisioned |
| Release artifact | Clean-commit source+dist archive, per-file SHA-256 manifest and sidecar, safe extraction, frozen dependency install | Same-commit browser/security/performance/human/staging acceptance still required |

Coverage labels and reasons are part of the product. Absence of a resolved edge does not establish absence of a dependency. A visible file count is not a claim that every file was parsed. Demo diffs are synthetic and disabled; analyzed sources link pinned GitHub evidence.
