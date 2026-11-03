# Patchwork Constellation

Understand the footprint of many changes without reading every diff first.

Constellation maps a repository as **connected file circles and labeled islands**. Select multiple pull requests or commits, inspect changed areas and overlap, zoom into a module, and open file-level evidence in GitHub.

**Status: planned, not implemented.** This repository contains the implementation plan and design reference. No runnable application, live GitHub ingestion or configured model integration exists yet.

[Kanban build plan](https://github.com/users/oudaykhaled/projects/5) · [Issues](https://github.com/oudaykhaled/patchwork-constellation/issues) · [Milestones](https://github.com/oudaykhaled/patchwork-constellation/milestones) · [Figma design](https://www.figma.com/design/A7h1fCr1SbLPRwY4vstSup?node-id=17-2113)

[View the Constellation design and interactive prototype](https://www.figma.com/design/A7h1fCr1SbLPRwY4vstSup?node-id=17-2113)

*Figma reference with synthetic data. Implementation will add continuous interaction and real repository analysis.*

## Product direction

- One circle per file; labeled component/module/folder islands.
- Graph fills at least **80% of the default desktop viewport**; reference canvas is 93.6%.
- Continuous pan/zoom, minimap, search, semantic detail and a dismissible inspector.
- Exact multi-PR or multi-commit file union and overlap markers.
- Stable positions when source selection changes; no timeline or contribution-grid view.
- Deterministic baseline plus evidence-grounded AI + Jev grouping and reversible overrides.
- Keyboard controls and an accessible synchronized file list.

## Build plan

| Stage | Outcome |
| --- | --- |
| M1 Foundation | Monorepo, contracts, fixtures, CI and renderer decision. |
| M2 Real-data MVP | Read-only GitHub analysis, correct change sets and accessible graph exploration. |
| M3 Intelligence | Grounded proposals, Jev decisions, overrides, evaluation and budgets. |
| M4 Beta | Measured scale, security/recovery evidence and release rehearsal. |

The board contains **31 implementation issues** with acceptance criteria, verification, priorities, relative sizes and dependencies. No dates or implementation completion are implied by the plan.

## Start here

Read [product requirements](docs/PRODUCT.md), [architecture](docs/ARCHITECTURE.md) and [roadmap](docs/ROADMAP.md). Pick a Ready issue and follow [CONTRIBUTING.md](CONTRIBUTING.md).

Detailed plans: [graph/UX](docs/graph-ux.md), [data](docs/data-architecture.md), [AI/Jev](docs/ai-grouping.md), [delivery](docs/delivery.md). [Published issue index](planning/ISSUES.md) links every task and prerequisite. [planning/issues.json](planning/issues.json) preserves the reviewed backlog; GitHub issues are the live execution record.

Proposed stack: one TypeScript monorepo with a React web BFF, isolated analysis worker, PostgreSQL metadata/jobs and bounded immutable blob cache. Sigma.js/Graphology is a renderer candidate pending a measured spike. No run command, paid hosting or provider setup is claimed yet.

## License

A license has not yet been selected. Public visibility is not an open-source license grant. Record the maintainer's license decision before accepting external contributions or distributing a code release.
