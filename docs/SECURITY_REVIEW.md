# Security review — 2026-11-03

This is a bounded code and fixture review of the local application and the GitHub App implementation being integrated. It is not a deployed multi-user penetration test, private-repository authorization smoke test, or a security certification. Release acceptance depends on the remaining gates below.

## Data flow and authority

| Boundary | Data and authority | Implemented control / evidence |
| --- | --- | --- |
| Browser → BFF | Repository/ref/source IDs and grouping commands are untrusted input. An object ID is not authority. | Host/Origin checks, JSON/body/source-count bounds, runtime contracts, server-only credentials, request-scoped owner IDs; `tests/api/server.test.ts`, `github-app.test.ts`, `security-review.test.ts`. |
| Browser session → GitHub user/App | OAuth code/state binds the same browser; current user access intersects the App installation. | One-use hashed state, PKCE, opaque HttpOnly/SameSite cookie, HTTPS Secure cookies, CSRF for mutations, live discovery before every token/cache-backed private read. `apps/web/github-auth.test.ts`. |
| BFF → snapshots/jobs/grouping | Owner + repository scope is required independently of client state. | Composite owner-scoped memory keys and storage queries, no browser token, cross-user same-snapshot-ID and revoked-access regressions. Cached credentials and previously known installation IDs are not authorization. |
| GitHub → analysis | Paths, source bytes, manifests and import text remain data. | Fixed GitHub API/raw origins, no redirects, credential-separated caches, byte/time/file budgets, TypeScript AST parsing. The bare-Git fallback uses a fresh bare directory, no checkout, hooks, filters, external diff, textconv, submodules, imported scripts or dependency installation. |
| GitHub webhook → durable work | Only a verified raw-body HMAC authorizes the event; event owner/name/SHA does not authorize a tenant or choose a historical ref to apply. | Constant-time SHA-256 comparison, raw-byte limit, supported event list, delivery replay store, previously authorized installation routing. New inbox/refresh integration is owned by #20; real delivery and purge fencing remain a gate. |
| Analysis → optional AI | Repository instructions, labels, file paths and model output cannot change policy, destinations or tools. | AI defaults off; fixed provider origins; bounded metadata only; exclusions, output/evidence ID validation, uncertainty fallback, versioned budgets/caches. #22 owns policy leak/cancel/purge tests and #26 owns fail-closed evaluation. Account terms/retention are unverified. |
| Untrusted text → UI | Repository/model labels and source references must not become executable markup or arbitrary destinations. | React text rendering, fixed GitHub inspector link construction, HTTPS/GitHub-only canonical link schema, restrictive production CSP. `security-review.test.ts` verifies hostile labels and links. |
| Services → client diagnostics/artifacts | Errors, provider bodies, connection URLs and source excerpts must not escape through messages or error codes. | Constant allowlisted public diagnostics, generic unknown failure, no raw exception code; bounded aggregate CI summaries. Production artifact scan covers known credential formats and explicit sentinels, not every possible secret. |

Raw-body webhook verification follows [GitHub's delivery guidance](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries). Public error isolation follows [OWASP's error handling guidance](https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html). The production policy restricts resources, framing and external connections using the [CSP header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy). CSP permits inline styles required by positioned graph elements; it does not permit inline/evaluated scripts. Development Vite intentionally does not use the production policy.

## Findings

| ID / severity | Reproduction and impact | Resolution / evidence |
| --- | --- | --- |
| SEC-01 / medium | A worker exception containing a synthetic private excerpt, fine-grained PAT and credentialed URL was returned as a job `code`; raw messages previously passed through a narrow regex. This disclosed arbitrary exception text to a client and could persist it. | Fixed with constant public message/code selection in `public-errors.ts`, including unknown-code collapse. The regression first failed on the leaked job code, then passed after the boundary fix. #12 independently removed raw exception messages/codes from its durable queue; preserve that during integration. |
| SEC-02 / medium | Canonical link schemas accepted executable, credentialed and lookalike-host URLs. Actual inspector links now construct a fixed GitHub origin, but accepting such URLs in the service contract weakened other consumers. | Added `GitHubWebUrlSchema` to repository/source links; executable, HTTP, credentialed and lookalike destinations rejected. Test also verifies malformed URLs produce validation failure rather than a parser exception. |
| SEC-03 / low | Equal-character-length multibyte CSRF input reached `timingSafeEqual` with unequal byte lengths and raised a generic server error. No authorization bypass was found. | Byte-length comparison before constant-time comparison; malformed Unicode produces the intended CSRF denial. |
| SEC-04 / defense in depth | Production responses lacked an application CSP. No executable repository-label injection was demonstrated. | Added same-origin script/connect/worker policy, framing/object/base restrictions; production Chrome inspector and renderer recovery journeys pass with it. |
| SEC-05 / high release gate | If revocation deletes stored data while an older analysis/source/grouping mutation is still running, that completion can save the private data again after deletion. Current live authorization prevents a demonstrated unauthorized read, but purge/retention guarantees are not established. | Reported to #20 and root. The integrated purge adapter must fence/cancel all repository writes before deletion and test late completions against the actual queue, source and grouping paths. The callback contract alone is not a fix. Keep private/deployed beta blocked until verified. |

## Checks actually run

- Windows, Node 24.22.1 / pnpm 11.25.0, isolated issue-30 worktree based on integration commit `79f2c11`; other agents were active on the machine.
- `pnpm typecheck` passed.
- `pnpm test`: **187 passed, 1 PostgreSQL integration skipped**. Includes **26 focused** public-error/auth/contract/HTTP security assertions.
- Production build passed. With synthetic GitHub/OpenAI/TypeSafe server credential sentinels set during a second build, `node scripts/security-artifact-scan.mjs dist` scanned **21 text artifacts / 1,755,979 bytes / 0 violations**, including source maps. The scanner reports only counts, never matched secrets. A malicious synthetic artifact makes the scan fail.
- `pnpm audit --prod`: no known vulnerabilities reported. This registry result is point-in-time evidence, not proof of safety.
- Four Chrome journeys passed against the actual production server on isolated port 4430: three inspector evidence/recovery flows and renderer loss/list/retry. TypeScript worker execution and graph rendering remained usable under the CSP.
- Formatting check passed. This review added no credentials, private source, live account changes, webhook subscriptions or paid model calls.

Run the artifact scanner after a production build:

```sh
pnpm build
node scripts/security-artifact-scan.mjs dist
```

## Release gates and retention

Do not mark #30 complete solely because unit tests and the dependency scan pass. Verify SEC-05 in the integrated adapter. Repeat private cross-user/repository/cache revocation journeys with a real registered App and PostgreSQL; review TLS/proxy cookie/Host behavior in the actual deployment. Verify webhook ingress/replay after worker outage, configured AI exclusion/purge/evaluation hooks, owner-scoped grouping persistence, and log/artifact retention there. Account-side model deletion/ZDR terms are not established.

The bounded memory store is process-local; PostgreSQL snapshot/job retention defaults to 24 hours and supports repository-scoped deletion. The AI policy has separate bounded ephemeral cache retention and explicit purge; accepted manual histories must also be deleted for a disconnected/revoked repository by the integrated adapter. Removing a session or cached token alone is not data deletion. Bare-Git native processes still need a deployed hard process-memory/sandbox envelope; JavaScript worker heap limits do not constrain native Git memory. No archived repository extraction is implemented, so no archive-traversal capability is claimed.

No critical authorization bypass was reproduced in this bounded review. SEC-05 and the unverified deployed boundaries prevent a blanket beta-security acceptance.
