# AI grouping and Jev implementation plan

Status: implementation plan, reviewed against primary provider documentation on 2026-11-03. This is for **Constellation**, the second Figma direction: one circle per file, connected dependencies, labeled islands, pan/zoom, and a graph occupying at least 80% of the desktop viewport. The original contribution-grid direction is out of scope.

## Decisions

1. Build the repository facts and deterministic islands first. AI must enrich a usable, accurate graph; its absence must never prevent file-level review.
2. Keep graph facts, candidate interpretations, and accepted grouping decisions separate. Imports are parser evidence. Island membership is a grouping decision. Neither establishes that a change causes a runtime failure.
3. Preserve physical folder paths independently from semantic module/component labels. AI can suggest a semantic parent or display name; it cannot rewrite the repository tree.
4. Let Jev choose among bounded candidate memberships and evaluate focused claims. Use a configurable generative-model adapter for proposed names and short summaries. Jev is not the explanation generator.
5. Apply a new grouping revision only when the user accepts it. PR/commit selection changes the highlighted footprint, not stable island identity, placement or grouping.
6. Treat confidence as model uncertainty, not measured correctness. The application needs domain evaluation and evidence coverage separately.

## Verified Jev integration

Jev is TypeSafe AI's model. The official site links its documentation; the official API exposes model discovery and the System One decision endpoint. The adapter should target **https://api.typesafe.ai/v1/systemone**, discover account-supported models through **GET /v1/models**, validate the current schema, and pin the selected version. The TypeScript SDK is **@typesafe-ai/sdk**, currently documented for Node.js 22+. No production request or paid account setup was performed during planning. [Official API](https://api.typesafe.ai/redoc), [SDK](https://docs.typesafe.ai/sdk/javascript).

Choice returns an option, probabilities and confidence. Noul returns a yes/no probability; do not assume it has a confidence field. These fit a bounded membership decision such as “Which existing module best contains this file, or none/uncertain?” Include descriptions with candidate IDs to avoid classifying from a short name alone. [Choice](https://docs.typesafe.ai/primitives/choice), [Confidence](https://docs.typesafe.ai/confidence).

The provider currently documents Jev 1.14 and 1.13 and moving aliases. The implementation must discover available models and persist the actual response model. Limits and rates are provider/account configuration, not guessed constants. Pin a tested model version for reproducibility. [Models](https://docs.typesafe.ai/models).

Unresolved deployment gate: select the generative provider/model; configure authorized server-side credentials; verify account limits, applicable data-handling terms and a small redacted smoke test; then pass local evaluation. These are implementation prerequisites, not uncertainty about Jev's identity.

## Pipeline and ownership

`snapshot + source facts → deterministic hierarchy → compact evidence bundles → optional candidate naming → Jev bounded decisions → schema/evidence checks → proposed grouping revision → user review → accepted revision`

- Repository-data code supplies snapshot ID, stable file lineage ID, path-at-snapshot, language, resolved imports, export names, package/workspace metadata, and source evidence IDs.
- DATA-06 owns the canonical deterministic hierarchy using workspace/package boundaries and directory structure, with DATA-05 import evidence. The AI layer consumes that baseline; it does not duplicate its grouping algorithm. Shared, generated and unclassified buckets stay explicit. Configure island granularity without forcing a fixed number of islands.
- The generative adapter may propose concise component/module names and explanations with evidence IDs. Validate every referenced file/evidence ID against the snapshot; reject invented IDs and unsupported assertions.
- Jev ranks only valid candidate IDs. Include an uncertain option, calibrate thresholds per version, and record the full bounded decision response. Low confidence or insufficient evidence stays with the baseline/review queue.
- A file has one primary island for layout and optional secondary semantic tags; dependency links cross islands normally. Do not duplicate circles to show multiple memberships.
- Every accepted revision contains a mapping for all files, explicit exceptions, provenance and previous revision ID. Hashing the revision and stable identities prevents source-selection toggles from triggering wholesale regrouping.

## Data contracts

`GroupingRevision`: repositoryId, snapshotId, revisionId, parentRevisionId, status (baseline/proposed/accepted), algorithmVersion, modelRunIds, component/module hierarchy, membershipByFileId, exceptions, createdAt.

`MembershipDecision`: fileId, islandId, origin (rule/model/manual), evidenceIds, modelVersion, rawProbability, confidence when supplied, evidenceCoverage, reviewState. A displayed confidence label must distinguish vendor distribution confidence from application evidence coverage.

`ModelRun`: runId, provider, requestedModel, resolvedModel, policyVersion, evidenceDigest, inputSchemaVersion, responseSchemaVersion, tokenUsage, budgetReservation, timings, outcome. Store source-free telemetry by default; raw prompts/source are not normal logs.

`GroupingOverride`: stable override ID, grouping revision, operation, target IDs, previous values, actor, timestamp, migration status. Replay known renames by lineage; ask for review when a deleted/split/recreated file makes the mapping ambiguous.

## Resilience, cost and privacy

Provider calls run on the server/worker. Never include provider credentials in the browser bundle. Default to filenames, import metadata, package manifests and bounded excerpts only; disclose exactly which metadata/excerpts leave the app. Keep public/private repository policy explicit and provide a disabled/local-only baseline mode. Exclude credentials, environment files, private keys, generated/vendor content and configured paths before retrieval. This is a best-effort filter, not proof that arbitrary code contains no sensitive data.

Repository text is untrusted data. It cannot change system instructions, authorize tools, select arbitrary outbound URLs or broaden retrieval. AI has no write/execute capability. Render output as escaped text; prohibit arbitrary HTML and uncontrolled links. Reject response payloads outside the typed schema and allowlisted evidence set.

Reserve a per-analysis budget before scheduling calls. Cache by tenant/repository, immutable snapshot, evidence digest, model version and prompt/schema/policy versions; changing any key invalidates results. Deduplicate jobs, cap concurrency and retries, honor retry headers, and return a clear degraded baseline on timeouts, invalid output or exhausted budget. Provide cancellation with bounded in-flight completion. [Provider errors](https://docs.typesafe.ai/api/errors).

Do not claim zero data retention for every account. Check the actual chosen provider and plan before enabling uploads; TypeSafe's legal documentation distinguishes enterprise ZDR. [TypeSafe legal documentation](https://docs.typesafe.ai/legal).

## Evaluation and release gates

Use synthetic fixtures plus authorized public examples spanning monorepos, feature folders, layered architectures, shared packages, dynamic imports and misleading filenames. Keep a frozen human-reviewed holdout set separate from threshold tuning. Measure membership agreement, human review rate, grouping stability, unsupported-evidence rate, abstention behavior, cost and latency. Compare baseline alone, generative proposals alone and combined Jev gating.

Hard gates: zero unknown file/evidence IDs accepted; zero hidden source transfer in disabled mode; all manual overrides survive supported refresh/rename cases; provider failure always produces a usable baseline; malicious fixture text cannot change destinations or invoke tools. Quality thresholds should be decided from baseline measurements and recorded before rollout, not fabricated as guarantees. Enable model grouping behind a feature flag after the dataset/threshold review.

## Delivery ordering

- M2 real-data MVP: AI-01 enrichment/evidence contract wraps the DATA-06 deterministic hierarchy; remains functional without external AI.
- M3 intelligence: AI-02 provider integration gate and AI-05 controls; then AI-03 proposed grouping and AI-04 persistent revision/override APIs; UX-04 owns the review controls; AI-06 evaluation/rollout gate.
- M4 beta release depends on completed intelligent-path evaluation if AI grouping is enabled. Do not label deterministic-only behavior as “AI + Jev powered”.

