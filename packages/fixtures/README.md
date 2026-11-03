# Synthetic evidence corpus

All fixture names, source text, binary bytes, Git histories, HTTP responses and graph facts in this package are authored synthetic project content. They contain no private repository material, credentials or captured user traffic. `example.invalid` is deliberately non-routable. The Git corpus never contacts that URL, initializes a submodule, executes repository scripts, runs hooks, installs dependencies or fetches a remote. No third-party fixture dataset or license grant is imported. The repository owner still needs to choose the overall project code license; public visibility alone grants no redistribution license.

The browser-safe entry point remains `src/index.ts`. Node-only Git generation lives in `src/git-history.ts`; HTTP replay lives separately in `src/api-fixtures.ts` so browser builds do not acquire Node modules. Consumers may import these explicit source modules in test tooling.

## Canonical Constellation facts

The design inventory and source membership sets are authored independently of the application footprint implementation. Existing expectations stay fixed:

| Fixture | Files | Islands | Directed edges | Changed union | Files touched by multiple sources |
| --- | ---: | ---: | ---: | ---: | ---: |
| Three PRs `248/251/256` | 212 | 6 | 235 | 68 | 14 |
| Two PRs `248/251` | 212 | 6 | 235 | 57 | 2 |
| Commits `a81f3c2/b72d9e1` | 212 | 6 (5 affected) | 235 | 24 | 4 |

Scale fixtures use seed 42, 12 islands, exact unique directed edges, no self-edges, stable IDs and source membership at file indices divisible by 5 or 7. The first `n-1` edges connect a spanning chain; remaining edges use deterministic xorshift and a bounded dense-graph fill. Selection invariants are declared by index, not inferred from the implementation.

| Scale | Files | Edges | Mean outgoing degree | Directed density `edges/(n*(n-1))` |
| --- | ---: | ---: | ---: | ---: |
| MVP | 2,000 | 8,000 | 4 | 0.0020010005 |
| Stress | 10,000 | 40,000 | 4 | 0.0004000400 |

These are test input sizes, not a renderer capacity claim. `fixtures.test.ts` validates counts, IDs, references, set unions, overlap and seed stability against shared schemas.

## Hand-auditable Git history

`createGitHistoryFixture(emptyDirectory)` authors fixed-identity, fixed-date SHA-1 commits using the installed Git executable. Global/system config, hooks, signing and automatic line-ending conversion are disabled. Existing target contents are rejected without deleting them. Tests use temporary directories and remove only those known test directories.

1. `root`: eight tracked paths: `.gitmodules`, binary `assets/logo.bin`, generated `generated/schema.gen.ts`, four `src/*.ts` files, and gitlink `vendor/widget`. `main.ts` has one actual import of `./shared` and one unresolved `./missing` import. Gitlink objects are local, synthetic empty-tree widget commits.
2. `featureAFirst`: modifies only `src/shared.ts`.
3. `featureA`: modifies `shared.ts` again, adds `auth.ts`, deletes `deleted.ts`, exactly renames `legacy.ts` to `renamed.ts`, changes binary/generated files and updates the gitlink.
4. `featureB`: independently starts at root, modifies `shared.ts` and adds `billing.ts`.
5. `merge`: main merges A with `--no-ff`, yielding parents `[root, featureA]`. Its first-parent delta equals A's complete root-to-head delta.

`HISTORY_GOLDEN` declares the expected change lists directly from these operations. The A+B union contains eight paths and one overlap (`src/shared.ts`); rename lineage identifies the previous path without double counting it. Git's own `diff --name-status --find-renames=100%`, `numstat`, `ls-tree`, `merge-base` and parent references provide independent ground truth. The application analysis code is never called to compute these expected values. This corpus covers ordinary exact lineage, not ambiguous rename/delete/recreate policies.

## HTTP replay

`createApiScenarios()` returns fresh authored REST response steps for paginated PR discovery, ETag/304, 429 and secondary 403 Retry-After recovery, truncated recursive tree, PR changed-file limit (3,001 declared), capped comparison (301 source changes, only 300 returned), permission revocation, repository removal, expired credentials and changed PR head pins. `API_GOLDEN` keeps the comparison source truth separate because GitHub's capped response cannot reveal the missing path. The synthetic response never invents a 301-file pagination API.

`createApiReplay(steps)` returns a fetch-compatible ordered replay. It rejects unknown requests, writes, foreign origins and exhausted scenarios. It checks cancellation before consuming a step and never falls through to real network fetch. This package proves fixture facts; gateway-specific retry, cache, stale-selection and authorization tests must consume them separately.

## Regenerate and verify

Use Node 24, pnpm 11.25 and installed Git. No GitHub or model credentials are needed:

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run packages/fixtures
pnpm exec tsx packages/fixtures/src/regenerate.ts .cache/fixture-run-a
pnpm exec tsx packages/fixtures/src/regenerate.ts .cache/fixture-run-b
```

Each destination must be empty. The command writes a local Git repository, canonical design/scale JSON, API steps, hand-declared Git golden with immutable commit SHAs, and a SHA-256 manifest. Compare the two `manifest.json` files byte-for-byte. Fixed seed, dates, identity, source bytes and object format yield identical manifests across the two runs. Do not commit generated `.git` repositories or huge JSON outputs; source declarations and focused tests are the maintained corpus. Changes to canonical expectations require explicit design/domain review, not golden replacement from implementation output.
