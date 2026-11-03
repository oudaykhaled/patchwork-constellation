# Job and snapshot persistence

`@patchwork/storage` supplies a scoped storage adapter and GitHub webhook verification helpers. The default is bounded, expiring in-memory storage for the local demo. Configure `DATABASE_URL` to opt into PostgreSQL. A configured database failure is an initialization error; it never silently switches to volatile storage.

```ts
import { createStore, newJob } from '@patchwork/storage';

const store = await createStore({ databaseUrl: process.env.DATABASE_URL });
const scope = { ownerId: 'public', repository: snapshot.repository.fullName };
await store.putSnapshot(scope, snapshot);
await store.putJob(scope, newJob({ repository: scope.repository }));
const job = await store.claimJob(scope, 'worker-1');
// Renew the lease while processing. Only the current unexpired lease can finish.
if (job) await store.completeJob(scope, job.id, 'worker-1', {
  status: 'ready', snapshotId: snapshot.id,
});
await store.close();
```

The HTTP layer derives owner scope from an authenticated user/installation, or an explicit public-only local mode. Never accept `ownerId` from a browser as authorization. Every lookup and mutation includes both owner and repository. Snapshot repository must match its scope. Public-only analysis can share public results; private GitHub App access requires actual installation/user authorization before using this adapter.

PostgreSQL stores immutable-context graph payloads, jobs, leases and webhook delivery identifiers. The migration is `database/migrations/001_storage.sql`. Startup applies it within a transaction protected by an advisory lock unless `autoMigrate: false` is supplied. In production, apply migrations with a migration principal, then use a serving principal with only table DML rights and `autoMigrate: false`. Use provider TLS verification and an appropriate verified connection string; the code does not disable TLS certificate validation.

Job claims use a transaction and `FOR UPDATE SKIP LOCKED`. Claims increment bounded attempts; leases expire for restart recovery. Renew, complete and retry require the current worker and an unexpired lease. Cancellation clears a lease and prevents in-flight completion from overwriting it. Retry stores bounded error text and availability delay. A final abandoned lease becomes failed on the next claim. Workers must claim only scopes they are authorized to process; the adapter does not select installation credentials.

Memory defaults: 100 snapshots, 500 jobs, 5,000 delivery IDs, one-day retention. Snapshots use LRU eviction; new jobs receive backpressure when capacity is full of active work. Terminal/expired jobs can be evicted. Graph payloads are limited to 16 MiB and jobs to 1 MiB. PostgreSQL retention is one day by default; schedule `store.prune()` and set operational storage/queue limits separately. `deleteRepository(scope)` removes only that owner/repository's snapshots, jobs and delivery history for disconnect/revocation handling.

For local PostgreSQL, set `POSTGRES_PASSWORD` and run `docker compose up -d postgres`. Configure `DATABASE_URL` using that local password; credentials belong in ignored environment configuration, never tracked examples or logs. Compose binds port 5432 only on loopback. This task does not create a hosted database.

Webhook helpers validate HMAC-SHA256 over the exact raw bytes with a constant-time comparison, reject bodies above 1 MiB, and allow only the supported event names. `verifyWebhook(raw, {signature, deliveryId, event}, secret)` must run before parsing/processing. Derive scope through the verified installation lookup, then call `acceptWebhookDelivery(store, scope, webhook)`; duplicate deliveries are acknowledged without reprocessing. A valid signature alone does not establish user authorization or justify a snapshot refresh. The HTTP integration owns raw-body limits, authorization, event routing and durable refresh enqueue.

`pnpm exec vitest run packages/storage/src/storage.test.ts` exercises memory isolation, bounds, lease recovery, retries, cancellation and webhook tampering/replay. An opt-in PostgreSQL test uses `TEST_DATABASE_URL`, unique disposable owner scopes and repository-scoped cleanup. Without that variable, PostgreSQL integration is explicitly skipped; memory tests do not establish database/runtime correctness.
