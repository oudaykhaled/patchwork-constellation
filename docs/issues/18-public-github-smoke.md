# Issue #18 — live public GitHub transport smoke

This opt-in check uses the product's actual BFF routes, isolated worker threads and unmodified GitHub transport against the public `octocat/Hello-World` example. It pins context `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d` and two immutable commits. It exercises repository analysis, job polling, source discovery, multi-commit loading, exact union/overlap counts, file detail and a genuine pinned GitHub diff. Independent GitHub API responses supply tree and changed-file ground truth.

Run from an isolated checkout with the frozen dependencies installed and no `.env`:

```powershell
pnpm exec tsx scripts/public-github-smoke.ts --live
```

The command clears provider, GitHub and database settings only inside its own process. It creates an ephemeral loopback listener, disables AI, uses public anonymous GitHub requests and shuts down its server/workers afterward. It never reads the GitHub CLI credential. The fixture inventory must be exactly the single `README`; independent API verification has an eight-request limit, application requests are checked against a 40-request ceiling, responses have a 2 MB limit and the run has a 90-second deadline. A real GitHub outage or exhausted anonymous quota fails the command; this network check is not part of routine offline PR CI.

The allowlisted result is written to `.tmp/public-github-smoke.json`. It contains pinned public metadata, counts, coverage, aggregate request totals, source/runner identifiers and the generated public diff destination. It contains no credential, response body or repository source. Preserve the result with its recorded source commit when publishing evidence.

## Observed run

The [published raw result](../evidence/live-public-github-smoke.json) passed all **six checks** at committed source `3d037815dd420326ea4aafb4da720cd3918e8c23` on 2026-11-03, Windows x64 / Node 24.22.1. The run took **6,206 ms**. The product BFF/worker made **13 actual GitHub requests**, with one cache hit, zero retries and zero rate-limit responses. Independent ground truth used three API requests; comparison HTML and raw pinned diff used two additional requests. Model requests were **zero**.

The single inventoried file and both selected commit changes matched independent GitHub evidence: **one changed file, one overlapping file, two overlapping sources**. Context coverage remained explicitly partial because README dependency extraction is unsupported. The actual GitHub comparison and its `.diff` both returned HTTP 200; the raw diff contained the exact README file header. Initial comparison HTML omitted the lazy-loaded file anchor, so browser fragment navigation remains unverified in this report.

This tiny README-only fixture verifies live transport and exact change semantics. Its unsupported JavaScript/TypeScript import analysis is explicit; zero edges is expected. It is not evidence for large-repository analysis or a private account's GitHub App installation. The script verifies both the GitHub comparison's HTTP response and its actual `.diff` file header. GitHub can lazy-load the files pane, so initial HTML is not presented as proof that rendered fragment navigation succeeded. This command does not establish browser interaction, accessibility acceptance, a deployed environment, intelligence quality or beta approval.
