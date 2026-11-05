# Architecture

Status: selected system shape; exact package/framework versions remain to validate. No service is deployed.

| Boundary | Responsibility |
| --- | --- |
| apps/web | React UI, renderer adapter, semantic controls and authenticated server routes/BFF. |
| apps/worker | Bounded ingestion, Git fallback, AST indexing, grouping and provider jobs. |
| packages/contracts | Versioned runtime schemas and TypeScript domain/API types. |
| packages/github | Read-only gateway, pagination, quota handling and safe cache use. |
| packages/analysis | File identity, source semantics, import evidence and deterministic hierarchy. |
| packages/graph-core | Pure adjacency/filtering and deterministic layout/presentation logic. |
| packages/ai | Provider interfaces, data policy, evidence validation and grouping revisions. |
| packages/fixtures | Synthetic histories, golden outputs and seeded scale graphs. |

PostgreSQL stores installations, snapshots, source/grouping versions, jobs and webhook deduplication. Start with a PostgreSQL-backed queue and bounded content-addressed blob cache. Development may use local cache storage; hosted storage remains an adapter decision. No separate API deployment or graph database is needed for MVP.

## Data flow and invariants

Browser → authenticated BFF → durable queue → bounded worker → read-only GitHub/cache → file/import evidence → deterministic hierarchy → optional AI/Jev proposal → review/accepted revision → browser.

Resolve refs to immutable SHAs, compute individual change sets, index supported source, derive evidence/hierarchy and return progressive graph chunks with coverage. Job keys include repository, refs, analyzer and grouping versions. Cancellation/latest-request-wins prevents stale results replacing current selections.

Context defaults to the default-branch SHA pinned at analysis start and displayed as ref/SHA. Explicit context changes create snapshots. PR/commit selections are independent overlays, never an implicit merged tree.

Every file has an evidence-backed identity and one primary island. Physical paths, semantic labels, memberships and edge provenance remain distinct. Confirmed renames may preserve identity; ambiguous same-path branches cannot silently collapse. Layout depends on snapshot/grouping version/seed, never source selection.

Observed edges come from source analysis. AI proposals have evidence/model/uncertainty metadata but cannot invent dependencies or alter direct-change counts. Proposed, accepted and manual revisions stay separate; overrides migrate only with supported lineage.

## API and boundaries

DATA-01/DATA-07 define repository/source discovery, idempotent analysis/status/cancel, snapshot summaries, paged groups/nodes/edges, footprint overlays, file/neighbor evidence and refresh. AI-04 defines proposal/revision/override APIs. Validate schemas and current repository authorization at every endpoint. Opaque IDs do not authorize access. Choose polling or reconnectable SSE during implementation.

The GitHub App requests Contents: read, Pull requests: read and mandatory Metadata: read. User access intersects installation scope. Tokens stay server-side. Treat source as data; do not execute scripts, hooks, plugins or dependencies. Git fallback is isolated and bounded with no submodule recursion and constrained network destinations.

Jev makes typed membership decisions; a separately selected generative adapter proposes names/summaries. Validate known IDs, escape rendering, reserve budgets, cap retries and cache by tenant/repository plus immutable input/model/policy versions. Disabled/failing AI returns an honestly labeled baseline.

## Rendering and capacity

GRAPH-01 measures Sigma.js/Graphology for circles, rings, organic island backgrounds, labels and hit testing. Keep renderer/data/layout independent. Worker layout settles and preserves coordinates on selection, unless selection-only files overflow an island's rectangle or a new island's packed place is taken, which re-packs the map (see graph-ux.md). Culling/detail suppression must retain honest totals. WebGL failure offers a DOM list.

Target 2,000 files/8,000 edges with a 10,000/40,000 stress fixture. Hardware/browser/seed/cold-warm state are mandatory evidence; capacity is not established until measured.

See [data](data-architecture.md), [AI](ai-grouping.md), [graph](graph-ux.md) and [decisions](DECISIONS.md) for detailed requirements and primary sources.
