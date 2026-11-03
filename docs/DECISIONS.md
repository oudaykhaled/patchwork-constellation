# Decision log

| ID | Decision | Status and rationale |
| --- | --- | --- |
| ADR-001 | Constellation circles/islands only, ≥80% default desktop graph. | Accepted product direction. |
| ADR-002 | TypeScript monorepo, web BFF and isolated worker. | Accepted planning shape; coordinate contracts without premature service repositories. |
| ADR-003 | PostgreSQL metadata/jobs and bounded immutable blob cache. | Accepted shape; exact packages/adapters remain to validate. |
| ADR-004 | Individual-source footprint union; explicit context SHA. | Accepted; no merge simulation or misleading net line total. |
| ADR-005 | Stable layout independent of source selection. | Accepted interaction invariant. |
| ADR-006 | Source analysis establishes edges; AI proposes grouping. | Accepted trust boundary. |
| ADR-007 | Jev decision adapter plus configurable generative adapter. | Official TypeSafe API verified; account/model validation and evaluation still required. |
| ADR-008 | Sigma.js/Graphology renderer candidate. | Proposed; GRAPH-01 must prove features and capacity. |
| ADR-009 | TypeScript/JavaScript dependency analysis first. | Accepted MVP scope; other file types retain explicit unsupported coverage. |
| ADR-010 | No dates, deployment or license implied by planning. | Capacity, hosting/cost and owner license choice remain explicit decisions. |

## Resolve during implementation

- Supported Node LTS, package manager, React/BFF framework (Next.js or equivalent server-routed framework), queue/database libraries; verify compatibility and pin versions.
- Renderer ADR with measured envelope and fallback.
- Authorized generative provider/model and evaluated Jev account model/version.
- Cache retention, hosted storage, quotas and per-analysis budget defaults.
- Owner-approved license before external contributions/code release; selected hosting before deployment.

Record evidence and tradeoffs. Do not silently replace product invariants to simplify implementation.
