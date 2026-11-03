# Patchwork Constellation

See which parts of a repository a collection of pull requests or commits touches. Files are connected circles, and labeled islands reveal modules, folders and components.

This local-first web tool includes an interactive sample, public GitHub analysis, and optional read-only GitHub App authorization. It implements the second [Constellation Figma direction](https://www.figma.com/design/A7h1fCr1SbLPRwY4vstSup?node-id=17-2113). The [31-issue acceptance audit](docs/ISSUE_REMEDIATION.md) records implementation evidence and remaining release gates.

[Kanban board](https://github.com/users/oudaykhaled/projects/5) · [Issue index](planning/ISSUES.md) · [Verification](docs/VERIFICATION.md) · [Product requirements](docs/PRODUCT.md)

## Run locally

Use Node.js 24 and pnpm 11.25.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open **http://127.0.0.1:4310**. The sample opens without credentials or external model calls. The server binds to loopback and checks API Host/Origin headers. Hosted deployment needs the explicit proxy, account and release configuration described in the runbooks.

Stop either server with **Ctrl+C** in its terminal. To reset the default in-memory demo, stop and restart it, then open the root URL without saved-view query parameters. Configured PostgreSQL data and any explicit `GROUPING_STORAGE_PATH` are durable and are not erased by restarting.

`GET /api/health` checks the BFF; `GET /api/health/worker` starts the real analysis worker entry point without GitHub or provider calls. The worker probe is shared and cached for ten seconds. Invalid environment settings and unavailable configured startup services produce a readable configuration page and HTTP 503, with no credential values in diagnostics. Correct the configuration and restart the server.

`GET /api/readiness` additionally checks the real worker, storage, queue and production assets. Optional owner-scoped aggregate metrics and the verified local artifact/database rollback procedures are documented in [release operations](docs/RELEASE.md).

To serve the production frontend locally:

```sh
pnpm build
pnpm start
```

## Explore

1. Toggle sample PRs or switch to commits. Three PRs touch 68 files with 14 overlaps; removing #256 shows 57 files with two overlaps.
2. Drag, scroll or pinch the graph. Use +/−, Fit, pan buttons or arrow keys. Selecting changes preserves map positions.
3. Search for `refresh.ts`, inspect imports and source membership, or open the accessible file list. Sample diffs are labeled synthetic; analyzed repositories expose GitHub links.
4. Choose a public GitHub repository and an optional context branch/commit. Analysis pins the context SHA, reports progress and exposes partial coverage. Select PRs or commits to load independent footprints.
5. Open AI + Jev to review availability, preview proposals, rename islands and undo corrections. The file inspector can move a file to another island.

The default desktop graph fills more than 80% of the viewport. Its layout settles; zoom and source selection remain dynamic.

## Configuration

Copy `.env.example` to `.env` only when configuring optional services. Values stay server-side.

| Setting | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Optional token to increase public API quota; it does not authorize private repositories. |
| `GITHUB_APP_*`, `APP_ORIGIN` | Optional App login, repository-scoped tokens and current user-access checks. See [GitHub App setup](docs/GITHUB_APP.md). |
| `AI_ENABLED` | Defaults to false. External grouping must be explicitly enabled. |
| `TYPESAFE_API_KEY`, `JEV_MODEL` | TypeSafe Jev credentials and a pinned decision model. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Generative adapter credentials and a pinned naming model. |
| `AI_EVALUATION_MANIFEST` | Reviewed, version-matched evaluation gate. Credentials alone cannot enable intelligence. |
| `AI_EXCLUDED_PATHS` | Additional comma/newline-separated exclusions for external metadata. |
| `DATABASE_URL` | Optional PostgreSQL storage; see [storage setup](docs/STORAGE.md). |
| `GROUPING_STORAGE_PATH` | Durable single-host grouping history; defaults to `.cache/grouping.json`. An explicit empty value disables file persistence. |
| `GITHUB_WEBHOOK_SECRET` | Enables signed, durably queued webhook processing when App authorization and PostgreSQL are configured. See [webhooks](docs/WEBHOOKS.md). |
| `PORT` | Local HTTP port; defaults to 4310. |
| `API_REQUESTS_PER_MINUTE` | Bounded local API request quota, 1–2400; defaults to 240. Browser test servers explicitly use 2400 for independent journeys. |
| `OPS_METRICS_ENABLED` | Defaults to false. Enables source-free operational aggregates; App mode requires a valid session and returns that owner's observations only. |

The graph retains deterministic grouping until both providers and the reviewed evaluation gate are configured. External AI uses bounded metadata, validated IDs, reserved budgets, scoped caches and failure fallback. The current authored evaluation does not establish a navigation improvement; live intelligence remains gated. [Review the exact data policy](docs/AI_DATA_POLICY.md) before enabling external calls. Manual corrections persist separately and support revision conflicts, lineage review and undo.

## Analysis boundaries

Public repository inventory defaults to 2,000 files and parses at most 120 JavaScript/TypeScript files, with 80 KB per source blob. Unsupported languages, unresolved imports, API limits and truncated trees produce explicit coverage reasons. Import edges describe static review context rather than proven runtime impact. At most 20 sources can be selected together.

Each PR uses its own pinned comparison; each commit uses its first-parent delta. Their union highlights touched files and overlapping sources without creating a merged code state.

Optional App authorization, bounded bare-Git fallback, separate selected-head import layers, durable job recovery and signed webhook refresh are implemented. Refresh leaves the active map in place until explicitly applied. Coverage and resource limits remain visible; imported repository scripts and dependencies are never executed.

Real PostgreSQL checks include coordinator termination, lease recovery, stale-write rejection and durable webhook restart. Live App registration/delivery, human accessibility review, model evaluation and hosted release checks remain explicit gates. See the [acceptance audit](docs/ISSUE_REMEDIATION.md), [database evidence](docs/evidence/postgres-local.json) and [security review](docs/SECURITY_REVIEW.md).

## Checks

```sh
pnpm check
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e
```

`pnpm check` runs type checks, unit/integration tests and the production build. Browser tests cover selection, camera behavior, file inspection, recovery, grouping undo, viewport area and narrow/reduced-motion interaction. To use an installed Chrome for local Chromium checks, set `PLAYWRIGHT_CHROME=1` and run `pnpm test:e2e --project=chromium`.

CI uses read-only repository permissions, pinned actions, no deployment credentials and bounded failure-artifact retention. Hosted CI and required repository checks must be verified on GitHub; authoring a workflow does not enable branch protection.

## Source layout

The TypeScript workspace contains the React frontend/BFF in `apps/web`, job orchestration in `apps/worker`, and packages for contracts, fixtures, layout, GitHub, source analysis, grouping and storage. [Architecture](docs/ARCHITECTURE.md), [roadmap](docs/ROADMAP.md) and [contribution instructions](CONTRIBUTING.md) explain the boundaries.

## License

Licensed under [Apache License 2.0](LICENSE), selected by the repository owner on 2026-11-03. Third-party dependencies retain their own licenses.

The frontend and distributed fonts retain the exact installed [third-party license notices](apps/web/public/THIRD_PARTY_NOTICES.txt), with [package/version/source digests](apps/web/public/THIRD_PARTY_NOTICES.json). Builds verify these notices and copy them into `dist`; Geist and Geist Mono remain under OFL-1.1.
