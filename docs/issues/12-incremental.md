# Authorized incremental refresh handoff

This follow-up connects DATA-05's bounded syntax-fact reuse to the actual durable queue; it does not change the ref, source comparison or idempotency semantics of a result.

`SnapshotStore.getLatestSnapshot(scope)` returns the most recently **written**, unexpired snapshot for exactly one owner/repository. Memory LRU reads do not affect write order. PostgreSQL uses bound owner/repository parameters and an indexed `stored_at` timestamp. Migration 001 idempotently adds this column for existing local databases; serving with automatic migration disabled requires applying that migration first.

For each analysis attempt, `AnalysisJobs` obtains fresh server-only credentials, loads that exact scoped previous snapshot, verifies its canonical repository, and calls `createIncrementalAnalysisBaseline`. Missing, incompatible or invalid previous facts safely retain full bounded analysis. The baseline is an in-memory worker option; it is never persisted in job input and never determines job identity. Repository purge or cancellation during a delayed baseline read prevents worker startup. Publication retains the existing owner/repository epoch, live authorization and write barriers.

The worker explicitly allowlists serializable resource options. Its baseline boundary validates the shared strict schema, repository match and 2 MiB byte cap before cloning, then validates again in the child. Foreign, full-graph, oversize, cyclic or malformed data is replaced with a constant invalid marker so the analyzer reports a full-parse fallback without receiving the rejected metadata. Callback functions, fetch implementations, injected Git adapters and arbitrary option fields are never cloned. Source-overlay workers receive no context baseline.

The thin contract contains only schema/analyzer/parser versions, repository, pinned context SHA, and at most 500 file path/blob pairs with bounded static import facts. It carries no owner credentials, group labels, full graph, file source bodies, arbitrary model data or another owner's metadata. The analyzer rereads bounded declarative configuration and resolves those facts again; unchanged syntax reuse does not assert unchanged dependency resolution or Git rename lineage.

Verification before integration: typecheck and 38 focused assertions passed, with the opt-in PostgreSQL test skipped in that run. The suite covers write ordering/LRU/expiry, owner/repository isolation, credentials-before-read, no metadata read on revoked access, faulty foreign-store fallback, delayed-read purge fencing, persisted-job exclusion, strict worker options and baseline byte/schema/scope bounds. The live PostgreSQL rehearsal owner records the separate database result; this historical skip is not a statement about current database availability.

Run:

```sh
pnpm exec vitest run apps/web/incremental-jobs.test.ts apps/worker/src/options.test.ts packages/storage/src/storage.test.ts apps/web/analysis-jobs.test.ts apps/worker/src/worker-lifecycle.test.ts tests/api/job-auth-recovery.test.ts
```
