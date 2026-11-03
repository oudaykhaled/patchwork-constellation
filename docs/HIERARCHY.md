# Deterministic repository hierarchy

`packages/analysis/src/groups.ts` provides the canonical baseline for optional AI enrichment. It uses only pinned inventory paths and parsed declarative package manifests. It does not read source text, execute package scripts, use source selection as input, or infer dependency edges.

The payload separates `memberships` (one primary group per file), physical `folders` (parent links and direct/descendant counts), primary `groups` (islands), and optional cross-cutting `components`. Aggregate records are never file nodes. A file keeps its exact physical folder even when a module folds deep directories into one island. Components can contain explicit paths from several modules; they add membership metadata without replacing the primary island.

Priority is explicit module mapping, explicit Ungrouped mapping, nearest nested `package.json`, then a documented path rule. Automatic rules use the first directory, or the first two segments under `apps`, `packages`, `services`, `src`, and `lib`. Root files remain their own island; a root package manifest supplies its label. Nested packages retain separate islands regardless of size. No size-based merging occurs. This avoids a hidden threshold that would move files after unrelated inventory changes. There is no implicit ignore list: excluded analysis content can remain visible and be explicitly placed in Ungrouped.

IDs use physical boundaries or explicit stable IDs. Colors derive from the ID rather than the sorted group index, so discovering an earlier-sorted island does not recolor existing islands. Each group records the path rule, manifest path, or mapping entry supporting its label. Hierarchy revisions hash sorted physical paths, memberships, groups, components and counts; ingestion order and selected PR/commit IDs cannot change the result. Any source-only addition can extend the inventory but must preserve existing memberships and manual revisions.

## Repository mapping

Place a JSON file named `.constellation.json` at the pinned repository root. The static-analysis pipeline owns bounded retrieval and passes its parsed value to `deriveRepositoryHierarchy`. The mapping API is versioned independently from provider or prompt versions:

```json
{
  "version": 1,
  "modules": [
    { "id": "identity", "label": "Identity", "paths": ["apps/web/src/auth", "packages/session"] },
    { "id": "checkout", "label": "Checkout", "paths": ["apps/web/src/checkout"] }
  ],
  "components": [
    { "id": "commerce", "label": "Commerce", "moduleIds": ["checkout"], "paths": ["packages/pricing"] }
  ],
  "ungroupedPaths": ["vendor", "generated"]
}
```

`paths` are exact file paths or directory prefixes, matched at path-segment boundaries. They are literal strings; no glob/expression evaluation or external configuration loading occurs. Explicit modules win over Ungrouped when both match. The most specific module prefix wins; equally specific matches to different modules are rejected as ambiguous. A component may reference mapped module IDs and/or paths from any baseline module. Unknown component module IDs, duplicate IDs, unknown mapping versions, traversal and absolute paths fail validation. Missing visible mapped paths produce warnings rather than phantom files or empty rendered islands.

Remove a mapping entry to restore the manifest/path baseline. Physical folder records and repository node IDs remain intact. Interactive durable corrections and undo are owned by the grouping revision service, not by this declarative file parser. Neither this API nor `applyHierarchy` accepts or rewrites observed edges or source footprints.

## Integration

Call `deriveRepositoryHierarchy(paths, { manifests, mapping })`, with manifest records shaped `{ path, name? }`. `RepositoryMappingSchema` is exported for preflight validation. Apply the result with `applyHierarchy(nodes, hierarchy)` and publish `hierarchy.groups`, `hierarchy.revision`, and `hierarchy` on the snapshot. Store the bounded declarative inputs separately if later source-only nodes need the same rules. Invalid or unreadable configuration should produce an explicit coverage reason and a deterministic baseline, never be silently accepted as an override.

Run `pnpm exec vitest run packages/analysis/src/groups.test.ts packages/analysis/src/imports.test.ts packages/analysis/src/index.test.ts` for monorepo, single package, nested package, deep folder, cross-cutting component, explicitly ignored directory, reordered snapshot, conflict and sentinel-collision fixtures.
