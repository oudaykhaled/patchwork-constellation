# Constellation data architecture

This plan implements the second Figma direction: file circles, labeled islands, connected imports, and a dynamic graph. It does not implement a contribution-grid view.

## Recommended shape

Use one TypeScript monorepo: `apps/web` for the browser and authenticated BFF, `apps/worker` for ingestion/AST/Git jobs, `packages/contracts` for typed schemas, `packages/github` for the read-only gateway, `packages/analysis` for graph and change semantics, and `packages/fixtures` for reproducible test repositories. Keep PostgreSQL as the durable metadata/job store and a bounded content-addressed object cache for immutable blobs/snapshots. A separate graph database is unnecessary for the MVP's adjacency/selection workload; return versioned adjacency data to the browser.

Prefer a PostgreSQL-backed worker queue initially to avoid introducing Redis solely for jobs. The exact framework, queue package, ORM, and deployment target should be pinned during foundation work after compatibility validation.

The application is read-only toward analyzed repositories. It needs Contents: read, Pull requests: read, and mandatory Metadata: read via a GitHub App. Repository authorization must combine the signed-in user's access with installation scope. Installation credentials stay on the server.

## Source semantics

MVP selects either multiple PRs or multiple commits within one repository, never an implicit mixture. PRs use independently pinned merge-base-to-head deltas. A commit uses its first parent; a merge commit explicitly says first-parent, and a root commit uses the empty tree. The combined footprint is a union of direct file changes, not a merge simulation or first-to-last net diff. A reverted file still appears touched when its commits are selected. Overlap means two or more selected sources touched the file; it does not mean merge conflict.

Store source SHA pairs, versions, timestamps, change records, and per-source line stats. Do not sum overlapping line stats as if they were a net diff. Context defaults to the repository default-branch HEAD resolved to a visible immutable ref/SHA pair at analysis start. Users may explicitly choose another authorized branch/commit, creating a new snapshot; source overlays never change context implicitly. Context layout comes from that pinned repository snapshot; overlay added/deleted nodes and selected-source edges with their provenance. A source branch does not create an imaginary combined repository tree.

Renames carry source provenance. Maintain stable file lineage only when evidence supports it; preserve ambiguous same-path/cross-branch identities rather than falsely merging them.

## Graph evidence and grouping

One circle represents one file. Edges represent static imports/re-exports with direction and source-location evidence. Start with TypeScript/JavaScript and explicitly report unsupported language coverage. Do not execute repository code, package scripts, compiler plugins, hooks, or import targets. Preserve binary and unsupported files as inventory nodes.

Rule-based grouping uses workspace/package manifests, path boundaries, and user overrides. AI/Jev can later propose names and memberships through versioned contracts; inferred relationships cannot overwrite observed import facts. Source selection changes highlights rather than group membership or node position.

## Ingestion and job lifecycle

Resolve refs to immutable SHAs, fetch source/tree metadata, compute change sets, index supported files, resolve imports, group, and publish versioned graph chunks. Deduplicate jobs on repository/ref/analyzer/grouping versions. Emit coverage throughout the lifecycle so partial results never look complete.

GitHub documents a 3,000-file PR response maximum and a 300-file comparison limit; comparison file results appear only on the first page. Recursive trees may truncate at 100,000 entries or 7 MB. These require explicit checks, subtree traversal, or a bounded isolated Git fallback rather than blindly paginating and declaring completion. [PR API](https://docs.github.com/en/rest/pulls/pulls), [commits API](https://docs.github.com/en/rest/commits/commits), [tree API](https://docs.github.com/en/rest/git/trees).

Use immutable SHA caches plus conditional metadata requests. Queue requests per installation, honor Retry-After/reset headers, and use bounded backoff. Installation access tokens expire after one hour and can be restricted to particular repositories. [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

A Git fallback runs in an ephemeral worker with timeout/byte limits, no arbitrary network egress beyond the needed Git host, no working-tree execution, no submodule recursion, and no untrusted archive extraction outside its work directory. An unavailable or over-budget fallback yields a partial result.

## Refresh and persistence

Webhooks are verified before parsing, deduplicated by delivery ID, and enqueued. Immutable snapshots remain immutable. Updated PRs or pushes produce a new version and a refresh notice; the user keeps their current camera/focus until they apply it. Installation removal revokes access immediately and schedules retained data purge. [Webhook verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

Persist RepositoryInstallation, AuthorizedRepository, Snapshot, ChangeSourceVersion, FileIdentity, FileAtSnapshot, ImportEdge, GroupingVersion, SelectionAnalysis, Job, and WebhookDelivery metadata. Store raw source only in a bounded cache with explicit retention policy. Browser API responses are authorized independently; an unguessable snapshot ID is not a permission check.

## Delivery dependencies

DATA-01 is foundation. DATA-02/03 enable ingestion. DATA-04 defines change truth; DATA-05 builds dependency truth. DATA-06 gives useful deterministic islands. DATA-07 exposes progressive analysis to the graph UI. DATA-08 adds freshness. DATA-09 gates beta with correctness and access-control evidence.

All technical limits were checked against official GitHub documentation on 2026-11-03. These are implementation requirements and planned choices, not completed software.

