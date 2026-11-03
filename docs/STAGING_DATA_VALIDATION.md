# Staging correctness, isolation and resource gate

Run this against an owned disposable PostgreSQL database in an isolated nonproduction service environment. It starts production-mode BFF instances on dynamically allocated IPv4 loopback ports. Session issuance, browser-bound OAuth state/PKCE, CSRF, authorization intersection, RSA installation-token request signing, storage, graph APIs and webhook verification/processing are real application code. Only upstream OAuth/GitHub responses are authored fixtures; no external service, model, private source or real account is accessed.

```sh
STAGING_REHEARSAL=1 TEST_DATABASE_URL="$OWNED_STAGING_DATABASE_URL" AI_ENABLED=false \
  pnpm exec tsx tests/backend-release/staging.ts .tmp/staging/data-09.json
```

`TEST_DATABASE_URL` must identify PostgreSQL at `127.0.0.1`, `localhost` or IPv6 loopback, with a database name beginning `constellation_`. Use a secret/process environment, never a literal URL in committed commands or reports. `DATABASE_AUTO_MIGRATE=false` uses an already migrated schema and permits a DML-only serving principal. Otherwise the existing migrations run before the scenarios. The release staging workflow owns database provisioning, role grants, backup/restore and teardown; this data gate does not provision a host or change an existing user's database.

The optional Vitest wrapper uses the same opt-in and actual implementation:

```sh
STAGING_REHEARSAL=1 pnpm exec vitest run tests/backend-release/staging.test.ts
```

Success records seven passed stages in `data-09.json`: sessions/CSRF/owner isolation, cached authorization revocation, complete 10k/40k progressive delivery, request/source bounds, account-wide disconnect purge, signed installation removal/replay, and rate-limit enforcement. Any failure exits nonzero. The standalone command deliberately emits a constant failure message; the report preserves only completed check IDs and safe diagnostic aggregates. CI should upload this exact report, not a recursive dump of the workspace or environment. Its `commit` and `workingTreeDirty` fields distinguish committed evidence from local preparation.

Keep the existing authored-Git and hostile-input gates alongside staging:

```sh
pnpm exec vitest run tests/backend-release/correctness.test.ts tests/backend-release/isolation.test.ts
PG_PROCESS_REHEARSAL=1 pnpm exec vitest run packages/storage/src/storage.test.ts \
  packages/storage/src/webhook-postgres.test.ts tests/backend-release/postgres.test.ts
```

The PostgreSQL commands require the same disposable `TEST_DATABASE_URL`. Process recovery genuinely kills the owned child and waits for the actual lease expiry. Coordinate access when sharing a local cluster; the committed staging gate does not stop an unrelated database or service. It closes only its own HTTP servers, controllers, inbox and pool connections, removes its randomly named authored owner/repository data, and restores the process environment.

One successful runner establishes these correctness and application resource bounds for its recorded environment. It does not establish external GitHub delivery, production capacity, a kernel resource sandbox, browser/GPU performance, human accessibility or live model quality. Those capabilities retain their own evidence and gates.
