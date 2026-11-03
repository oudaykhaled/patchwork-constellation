# Product requirements

## Primary journey

Choose an authorized repository → select multiple PRs **or** commits → inspect footprint and overlap → zoom into an island → inspect a file/import neighbor → open its diff. Optional grouping review accepts or corrects AI suggestions.

The sole visual reference is [Constellation, the second direction](https://www.figma.com/design/A7h1fCr1SbLPRwY4vstSup?node-id=17-2113). Each circle is one actual file. Island boundaries communicate components, modules and folders. The default graph surface is ≥80% at 1280×720, 1440×900 and 1600×1000. Controls float; details dismiss.

## Source and graph semantics

Filled green means directly changed; hollow circles retain unchanged context; an outer ring means at least two selected sources changed a file. Focus and status also have non-color cues. Connections expose type, direction and evidence. Import edges do not prove runtime breakage, and overlap does not prove merge conflict.

MVP modes are separate within one repository. Each PR uses its pinned merge-base-to-head delta. Each commit uses first-parent-to-commit, with explicit merge/root handling. The footprint is the touched-file union, not a merged state or first-to-last net diff. Preserve per-source line stats where adding them would mislead.

Context defaults to the repository default-branch HEAD resolved to an immutable SHA at analysis start. Display its ref/SHA. An explicit authorized branch/commit choice creates a new snapshot; selecting PR overlays never changes context implicitly.

Layout is keyed by context snapshot/grouping revision. Selection changes highlights/counts without moving existing nodes or resetting the camera. Added/deleted files remain discoverable with provenance. Refresh is explicit and preserves valid focus. Dynamic means real camera/data interaction; layout settles rather than jiggling perpetually.

## Required capabilities

- Repository connect/switch/disconnect, authorized discovery, analysis progress and recovery.
- Drag, wheel/trackpad and pinch navigation; keyboard pan/zoom; Fit all/selected island; minimap.
- Semantic zoom with collision-aware labels, search and evidence-backed file inspector.
- Paginated multi-selection with source modes, clear/apply and per-file membership details.
- Grouping source/evidence/uncertainty, preview before apply and reversible correction.
- Accessible synchronized list, focus restoration, reduced motion and narrow-screen review.

## Completeness and trust

Coverage explicitly distinguishes complete, partial, unsupported, failed and excluded. Empty/loading/canceled/rate-limited/stale/revoked states have separate recovery. Missing edges are not proof of no dependency. AI cannot alter observed edges or changed-file counts.

Deterministic grouping works without credentials or on provider failure. Disclose fields/excerpts sent for optional external analysis. Every result and cache lookup checks current repository access.

## MVP boundaries and validation

TypeScript/JavaScript import analysis first; other files remain inventoried with unsupported edge coverage. Read-only GitHub App access, no repository code execution, no merge simulation, no timeline or contribution-grid fallback. Cross-repository graphs, additional parsers and collaboration can follow beta evidence.

Verify the journey: select changes, explain overlap, locate a module, inspect a connection and open a diff. Record observed task performance; do not invent success metrics.

Synthetic fixture: 212 files, six islands, 235 connections; three PRs touch 68 unique files/14 overlaps, two PRs touch 57/two overlaps, two commits touch 24/four overlaps across five affected islands. These are demo expectations, not production assumptions.
