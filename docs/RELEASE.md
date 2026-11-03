# Release and rollback runbook

The repository owner selected **Apache-2.0 on 2026-11-03**. [LICENSE](../LICENSE) governs repository code; dependencies retain their own licenses. The selected nonproduction deployment is an **ephemeral GitHub Actions runner with real Node services and PostgreSQL on loopback**, described in [the staging procedure](STAGING.md). Local artifact rehearsals remain available. A persistent public hosting service and production release approval remain separate maintainer decisions.

## Build a reviewable artifact

Use Node 24 and the pinned pnpm 11.25.0. In a clean, committed checkout:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:release
pnpm release:pack
```

`release-artifacts/patchwork-constellation-<version>-<commit>.tar.gz` contains allowlisted tracked source, tests, workflows, manifests, migrations, linked evidence/documentation, Apache license and built `dist`. A SHA-256 sidecar authenticates accidental corruption only; obtain both files from the trusted CI run or a verified maintainer checkout. It is not a signature or a substitute for trusted provenance. The manifest records every file digest, byte count, exact commit, package manager, Node constraint and deterministic-preview mode. No installed dependencies, `.env`, keys, Git metadata, test traces or local caches are packaged. Safe extraction rejects traversal, symlinks, duplicate entries and oversized archives.

Two packaging passes on the same committed checkout and built output must have the same digest. A dirty checkout is refused by default. `--allow-dirty` exists for local troubleshooting and labels the artifact `-dirty`; it cannot satisfy a reviewed promotion record. Install dependencies from the frozen lockfile after extraction, **including the pinned tsx runtime**; do not use `--prod` until a separately tested bundled server artifact exists. Then run `pnpm start`. Source packaging is explicit; this is not a dependency-free executable.

Frontend redistribution includes exact [third-party license bodies](../apps/web/public/THIRD_PARTY_NOTICES.txt) and [installed package/source SHA-256 provenance](../apps/web/public/THIRD_PARTY_NOTICES.json) for React, React DOM, Scheduler, Lucide, Zod, Geist and Geist Mono. `pnpm build` verifies these against the actual installed packages and Vite copies both files into `dist`. The artifact manifest records their digest and all seven package/version/license identifiers; artifact verification refuses distributed font files without accompanying matching notices. The font licenses remain OFL-1.1. Run `pnpm notices:generate` after a deliberate dependency update and review the exact upstream license changes before committing; `pnpm notices:check` is a non-mutating check. Stable LF attributes preserve the raw notice digest across Git checkouts.

## Preview and production separation

The manually dispatched [Release candidate workflow](../.github/workflows/release.yml) takes a full reviewed commit, builds/checks it without provider or deployment secrets and uploads bounded 14-day artifacts. Preview is the default. Its `staging` option performs the [ephemeral deployment, native database restore and stable-address traffic rollback](STAGING.md) using two distinct compatible artifacts. It does not push tags, publish a GitHub release or write to production. Production requires dispatching the workflow from `main`, source reachable from `origin/main`, and `.release/acceptance.json` for the exact commit. Configure protected `preview` and `production` GitHub environments with appropriate reviewers before using their review controls; workflow YAML alone does not establish those settings.

The acceptance record is intentionally absent. It must be reviewed by the maintainer and contain `schemaVersion: "1"`, `stage: "production"`, `intelligence: "disabled"`, `license: "Apache-2.0"`, `commit`, `hosting`, `reviewedBy`, and evidence entries named `browser`, `accessibility`, `performance`, `backend`, `security`, `deployment`, `databaseRestore`, `rollback`. Each entry requires `status: "passed"`, an evidence `reference` and the same `commit`. Do not copy the synthetic unit-test record as release evidence. Intelligence-enabled releases require AI-06's separate evaluated, reviewed live-model gate; this deterministic release gate refuses them.

## Credentials and operating limits

The deploying maintainer owns credentials and revocation. Keep GitHub App private key, OAuth secret, webhook secret, database connection and model keys in the hosting secret manager or ignored local environment. Never place credentials in release artifacts or browser settings. Local mode needs none. The App installation/user intersection and each endpoint's current authorization must be verified before enabling private repositories.

Documented defaults are two concurrent analysis workers, at most 20 selected sources, 128 KB JSON API bodies, 2,000 inventory files, 120 parsed JS/TS blobs at 80 KB each, bounded job time and bounded snapshot storage. These are data/resource limits, not a throughput promise. AI stays disabled. Configured AI account limits, evaluated model IDs, data terms, request/token reservation and a measured dollar cap require separate review; telemetry reports unknown dollar cost as `null`, never zero. Consult [capabilities](CAPABILITIES.md) and integrated issue evidence when limits change.

## Readiness and aggregate observations

`GET /api/health` checks that HTTP is alive. `GET /api/readiness` checks the actual cached worker probe, durable owner-scoped queue query, storage and production assets; failure is 503 with a fixed-name status map, without connection strings. Each dependency has a bounded probe deadline. The public readiness response contains statuses only, not owner activity. Readiness does not prove external service uptime or release acceptance.

Set `OPS_METRICS_ENABLED=true` to expose `/api/metrics`. In local mode it stays behind the loopback Host/Origin boundary; App mode additionally requires a current authenticated session and returns that owner's aggregates only. Worker execution, pending enqueue and failure counts are owner-scoped too. It contains queue age and analysis duration sums/counts/maxima. The actual worker strips callbacks before serialization, sends only strict versioned GitHub telemetry messages, caps observations at 2,000 per job, and validates them again in the BFF. No arbitrary repository output enters the telemetry sink. Generative/Jev calls report actual request/usage counts, latency and fixed outcome buckets; disabled/unavailable mode records observed zero transfer. Failures with unknown usage remain unknown, and unverified dollar cost is `null`. Restart or bounded registry eviction resets counters; durable queue counts are a separate store query. Export aggregates only to a maintainer-authorized sink with retention/access configured. No source, prompts, repository identifiers, owner IDs, token values or exception text appear in the metrics response.

## Rehearse artifact deployment and rollback

Keep both the candidate and last known-good archive, checksum and manifest. In a disposable checkout with cached package dependencies:

```sh
pnpm release:rehearse <candidate.tar.gz> <previous.tar.gz>
```

The script verifies and safely extracts both artifacts into fresh `.cache/release-rehearsal-*` directories; installs offline using the lockfile; starts the candidate on loopback port 4531; checks health, production HTML, the 212-file demo and provider-disabled baseline; stops it; then repeats those checks on the previous artifact at port 4532. It clears external-service credentials for both processes. It retains a redacted JSON record and extracted directories for review. No hosted service or database is changed. Stop any owner process occupying those explicit rehearsal ports before running. A local artifact rollback proves that process/artifact procedure only, not production networking or persistent-schema rollback.

For hosting: drain admission, record current artifact+schema, retain the last known-good artifact, stop the old process, install/verify candidate with least-privilege serving credentials, check readiness and an authorized repository flow, then switch traffic using the hosting platform's reversible mechanism. On failure, drain/stop candidate, restore the compatible prior artifact, run readiness/authorized smoke and record the result. Do not downgrade a database schema blindly.

## Database migration, backup and restore gate

PostgreSQL remains opt-in. Apply all versioned migrations with a migration-only principal and use a serving principal with only required DML privileges, configured with `DATABASE_AUTO_MIGRATE=false`. This setting disables both snapshot/job and durable-webhook startup migrations; invalid switch values fail configuration validation. Migration IDs, schema compatibility and artifact IDs belong in the deployment record. Before deployment, take an encrypted, access-controlled database backup using your verified provider or `pg_dump --format=custom` with credentials supplied through its approved secret channel. Restore into a **new disposable database** using `pg_restore --no-owner --exit-on-error`; run migrations and the opt-in storage integration suite against it, then compare scoped snapshot/job counts. Do not overwrite the live database or print a connection string.

The follow-up rehearsal used verified native PostgreSQL 17.11 binaries and a protected local test helper. [Actual evidence](issues/31-database-rehearsal.json) records two newly created disposable databases, migrations 001/002, a native custom backup/restore, matching scoped snapshot/job digests and four table counts, and idempotent migration after restore. Both disposable databases were dropped and the owned PostgreSQL process stopped; no existing database was overwritten. `tools/release/database-rehearsal.ts` refuses unconfigured/non-loopback services and retains only a synthetic backup plus a redacted report. This establishes local database migration/restore behavior; **no hosted traffic rollback or production database restore is claimed**. A maintainer must still rehearse staging-specific deployment, networking, least-privilege credentials and persistence rollback before production acceptance. Back up grouping override storage separately if `GROUPING_STORAGE_PATH` is used; verify atomic revisions and undo after restore. Provider-disable fallback with a live configured account still requires outbound-observation evidence.

## Acceptance evidence

Link the same-commit results from [browser #18](issues/18.md), [accessibility #17](issues/17.md), [grouping UX #25](issues/25.md), [graph capacity #27](issues/27.md), [backend #28](issues/28.md), [integrated recovery #29](issues/29.md), [security #30](issues/30.md), [AI evaluation #26](issues/26.md), and [this issue #31](issues/31.md). Repeat keyboard, screen-reader, reduced-motion and focus-return journeys for intelligence controls after integration. Never replace an unavailable human review with automated pass counts. Tags and intelligence-enabled releases stay pending while required evidence is missing.
