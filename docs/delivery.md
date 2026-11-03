# Delivery and release plan

This plan builds only **Constellation**, the second Figma direction: circle-per-file graph, labeled islands, connections, progressive detail and pan/zoom. The graph canvas occupies at least 80% of the desktop viewport; the reference uses 93.6%. The first contribution-grid approach is out of scope.

This repository starts as a planning repository. Tasks below describe future implementation; no deployed application, completed CI run, performance measurement or security audit is implied.

## Build shape

Use one TypeScript monorepo. Keep deployment units separate inside it rather than creating service repositories before independent ownership is needed.

- `apps/web`: React interface, graph renderer and authenticated backend-for-frontend (BFF); public demo works without credentials. Server routes own GitHub installation authorization and analysis orchestration.
- `apps/worker`: bounded source ingestion and analysis jobs; never execute imported repository code or install its dependencies.
- `packages/contracts`: versioned request/response and persisted graph schemas shared by API, worker and web.
- `packages/graph-core`: pure graph/filter/grouping logic without UI or provider credentials.
- `packages/fixtures`: authored synthetic repositories, golden graphs and deterministic benchmark inputs.
- `docs`: product definition, architecture decisions, threat model, operations and release evidence.

Select a supported Node.js LTS and package-manager version during DEL-01; pin the versions and lockfile in the repository. Avoid committing machine-specific paths or local credentials. Exact graph, database and job-system choices are owned by the corresponding architecture decision records. Choose and document a repository license before accepting external contributions or distributing a release; public visibility alone is not a license grant, and this plan does not select or apply a license on the owner's behalf.

## Milestones and release gates

| Milestone | Observable exit gate |
| --- | --- |
| M1 foundation | Clean clone boots the demo; shared contracts and fixtures validate; PR checks pass; graph renderer choice has benchmark evidence. |
| M2 real-data MVP | A public repository can be analyzed with read-only access, multiple PRs or commits show correct deduplicated changes, file neighbors can be explored, incomplete analysis is explicit, and keyboard access is available. Deterministic grouping is sufficient. |
| M3 intelligence | Verified provider adapters return grounded, schema-checked suggestions; overrides survive reanalysis; evaluation, cost and failure gates pass. An unresolved Jev provider remains explicitly unavailable rather than being faked. |
| M4 beta | Integrated journeys, scale tests, authorization boundaries, operational recovery and a staged deployment/rollback rehearsal pass with linked evidence. |

No calendar commitment is implied. Milestones should progress after their exit evidence exists. AI work can proceed in parallel after stable graph contracts, but it must not block the deterministic MVP.

## Verification layers

1. Pure domain tests: change set union and overlap, stable file identity, deterministic layout/grouping seeds and filter invariants.
2. Integration tests: GitHub adapter, job retries/cancellation, repository permissions, caches and graph schema boundaries. Use controlled fixtures; authenticated smoke tests are separate from untrusted pull-request CI.
3. Browser tests: select PRs and commits, inspect an island/file, zoom/pan, update highlights without moving the unchanged layout, handle stale/partial states, and preserve keyboard focus.
4. Visual review: compare the seven Constellation reference states at 1600×1000 plus 1440×900 and 1280×720; check overlay fit and that the canvas remains at least 80% on supported desktop sizes.
5. Performance and resilience: reproducible seeded graphs, recorded hardware/browser/build, cold versus warm runs, cancellation and failure recovery. Budgets below are initial acceptance targets, not measured claims.
6. Security review: adversarial repository names/content, authorization revocation, untrusted Markdown, provider output and source processing bounds; document findings and fixes.

### Initial performance targets

Use the graph team's agreed benchmark matrix as the authoritative renderer benchmark. For integrated release testing, start with 212 files/235 edges (design fixture), 2,000 files/8,000 edges, and 10,000 files/40,000 edges. Record actual serialized sizes and density; a file-count-only benchmark is insufficient.

On a documented mid-range laptop/browser profile, target p95 warm selection feedback ≤250 ms and hover response below 100 ms on the 2,000-file graph, and p95 frame time at or below 33 ms while panning its visible detail. Target the first useful cached graph within 2 seconds after authenticated response on the documented network profile. Larger datasets must retain responsive controls through culling, detail reduction and cancellation, show progress, and never silently omit files. A failed initial target triggers profiling and a documented capacity adjustment, not invented pass results. Server ingestion targets are separate and must account for GitHub quota and repository size.

## Kanban policy

Statuses: Backlog → Ready → In progress → In review → Done. Record a blocked dependency or external capability in the issue; it prevents promotion to Ready. Ready means dependencies are resolved, acceptance criteria are testable and fixtures exist. In review requires a PR, relevant test evidence and screenshots for visual work. Done means merged and accepted against the issue criteria; it does not mean merely drafted.

Keep work in progress small: one active implementation issue per contributor, no more than three In progress and five In review across the project. Label cross-cutting issues by their primary area and link dependencies explicitly. Size S/M/L describes relative effort, not promised days. P0 items establish or protect the core path; P1 items complete beta quality.

## Delivery definition of done

- Acceptance criteria pass and evidence links are in the issue or PR.
- Tests cover meaningful user or correctness risks, including failure paths.
- Keyboard and reduced-motion behavior are checked for changed interactions.
- Logging contains diagnostic IDs and aggregate timings, never source content, tokens or model prompts by default.
- User-visible limitations and deployment/configuration changes are documented.
- No unreviewed critical/high security finding is knowingly shipped.
- A rollout/rollback mechanism exists for changed deployed services.

## CI and release practice

Use ordinary pull-request checks without deployment secrets. Grant workflow tokens only required permissions and pin external actions to immutable full commit SHAs, with update automation. A separate trusted release workflow deploys versioned artifacts. This follows [GitHub's secure workflow guidance](https://docs.github.com/en/actions/reference/security/secure-use).

Capture failure screenshots and traces for browser checks, with bounded artifact retention and no authenticated production data. Playwright supports this in its [recording configuration](https://playwright.dev/docs/test-use-options#recording-options). Do not hide flaky tests with unlimited retries; keep a retry budget and investigate recurring failure.

Release notes distinguish demo mode, deterministic analysis, available AI integrations, supported language analysis and known scale limits. Production hosting, paid infrastructure and provider credentials remain implementation decisions; this planning task does not deploy them.
