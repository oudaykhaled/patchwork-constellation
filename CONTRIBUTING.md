# Contribution workflow

This repository contains the Constellation application and its build plan. A maintainer-selected license is required before accepting external code contributions or releasing a distribution; public visibility grants no code license.

1. Read one Ready issue's dependencies, acceptance criteria, verification and design.
2. Create an issue-specific branch; coordinate ownership of shared contracts.
3. Implement a complete scoped slice with meaningful correctness/user-flow tests and failure cases.
4. Open a PR linked to the issue. Describe behavior, validation and limitations; include screenshots/benchmarks where relevant.
5. Move to In review when evidence/checks are ready; Done only after accepted implementation is merged.

Backlog → Ready → In progress → In review → Done. Ready requires resolved prerequisites and testable criteria. Record external blocks in the issue; planning completion does not close implementation tasks. When the owner authorizes a parallel batch, each agent uses an isolated issue worktree and returns a tested commit for integration; merge and closure remain acceptance decisions.

No credentials, private repository source, raw model prompts or machine-specific paths in commits. Use synthetic/authorized fixtures. Never execute analyzed repository code. Demo mode makes no provider/GitHub calls.

Data analysis owns file/source identity and evidence; the graph consumes these rather than recomputing truth. AI owns proposal/revision APIs; UX owns review controls. Coordinate schema changes in packages/contracts once scaffolded.

## Required validation

Use the pinned Node.js and pnpm versions in package.json. Run `pnpm install --frozen-lockfile`, then `pnpm check` and `pnpm check:browser`. The check suite runs whitespace formatting, static source lint, the quality-gate failure regression, TypeScript, unit/contract/API tests and a production build. `pnpm format` fixes whitespace only; it does not rewrite application syntax. Static lint rejects debugger/with, direct eval/Function execution and focused test/it/describe calls. TypeScript owns syntax and type diagnostics.

Browser checks use deterministic public fixtures with AI disabled and server credentials cleared. Never point a PR check at production data. Install browser runtimes with `pnpm exec playwright install --with-deps chromium firefox webkit` on a supported machine. Add screenshots for changed UI, Git-ground-truth cases for data semantics, and benchmark evidence for renderer changes. Record skips and unverified criteria; a mock is not live-provider evidence.

The GitHub check names are **check** and **browser**, under **Implementation checks**. A maintainer can require these names in a branch ruleset, including up-to-date branches and review for workflow changes. Read back the repository rules before reporting protection enabled; this source change does not configure it. Do not merge a failing check or assume a draft PR satisfies acceptance.

## CI trust and diagnostics

The PR workflow uses ordinary `pull_request` (never `pull_request_target` or privileged `workflow_run`), read-only contents permission, ephemeral hosted runners and checkout without persisted credentials. It has no provider/deployment secrets or deployment steps. Imported repository content is analyzed as data, never installed or executed. Full action commit SHAs and Dependabot updates reduce action supply-chain drift; review action updates as code changes.

Failure artifacts contain a small JSON summary of allowlisted check names, exit codes and timings, retained seven days. Raw stdout, environment, traces and fixture/source payloads are excluded from uploaded artifacts. Local Playwright traces/screenshots remain available in ignored test output for deliberate review before sharing. This diagnostic policy bounds accidental data disclosure, not malicious contributor behavior; keep all privileged secrets out of untrusted jobs. See GitHub's [secure use reference](https://docs.github.com/en/actions/reference/security/secure-use).

Missing CI is not evidence of passing tests. planning/issues.json preserves the reviewed plan; GitHub issues are the live execution record. The owner's license choice and repository-rules readback remain explicit release gates.
