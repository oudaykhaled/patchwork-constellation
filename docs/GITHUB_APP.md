# Read-only GitHub App connection

The credential-free demo and public local mode remain the default. Setting all five App values enables the implemented session and repository authorization path. Partial App configuration fails startup rather than silently exposing public mode.

## Registration and local setup

Register a GitHub App owned by the maintainer. Request **Contents: read**, **Pull requests: read**, and mandatory **Metadata: read** only. Set repository access to selected repositories. No write permission is required. For refresh integration, subscribe to `installation`, `installation_repositories`, `pull_request`, and `push`; GitHub also sends authorization revocation events. Webhook ingress/refresh is a separate integration owned by DATA-08.

Register callback `http://127.0.0.1:4310/api/auth/callback` for a local test, or the exact HTTPS deployment callback. Set the following server environment values using the maintainer's secret storage; `.env.example` contains placeholders only:

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | Numeric App ID, distinct from client ID |
| `GITHUB_APP_CLIENT_ID` | App client ID |
| `GITHUB_APP_CLIENT_SECRET` | App OAuth client secret |
| `GITHUB_APP_PRIVATE_KEY` | RSA PEM, at least 2048 bits; literal `\n` separators are supported |
| `APP_ORIGIN` | Exact application origin, without path or trailing configuration parameters |

Run `pnpm dev`, open **Choose repository**, and use **Sign in with GitHub**. The repository dropdown uses the signed-in user's installation repository intersection. Selecting a repository fills the analysis form; submit it to create an analysis. A manually entered inaccessible repository is denied even if its installation ID or an old snapshot ID is known.

Production HTTPS termination/hosting, registration, installation and credential issuance have not been performed by this change. The current launcher still binds to loopback. Do not expose it by changing network binding until the deployment/security release gates pass.

## Implemented boundaries

- OAuth state is random, browser-cookie bound, single use and expires after ten minutes. PKCE uses S256.
- The opaque session cookie is HttpOnly and SameSite=Lax, and Secure for HTTPS. Plain HTTP is permitted only for explicit loopback development. Mutations require both exact Origin and a session CSRF nonce. App secrets, user tokens and installation tokens never enter browser responses.
- Sessions and OAuth state are held in bounded process memory. Sessions expire within eight hours; refresh tokens are deliberately not retained. Expiry/restart requires sign-in again. This is one process, not a distributed session store.
- Every protected repository/snapshot/job/source/grouping access rechecks GitHub's user-to-installation intersection. A cached installation token alone never grants access. Discovery has explicit caps; exceeding them fails with a request to narrow selected installations rather than silently omitting authorization data.
- Installation JWTs are signed server-side. Requested tokens are scoped to one authorized repository ID with read-only permissions; cached tokens refresh at least one minute before expiry. Private source content uses GitHub's fixed Contents API origin rather than unauthenticated raw URLs. Redirects are rejected.
- Snapshot caches and store scopes include the current GitHub owner ID. Job lookups reject another owner's IDs. Source request cancellation, in-flight deduplication and grouping services are owner scoped. Grouping durability remains the separate AI-04 workstream.
- Repository removal/revocation denies subsequent reads, including already-cached snapshots. Sign out invalidates the session and cached installation tokens; retained snapshot metadata remains governed by storage retention and cannot bypass later authorization. DATA-08 owns event-triggered purge/reconciliation.
- Recovered background jobs must call `GitHubAppAuth.credentialsForOwner(ownerId, repository)` to obtain fresh authority. Jobs must never persist credentials. Missing sessions fail closed with a reconnect instruction. DATA-07 integration must retain this requirement.

## Reproducible verification

`pnpm exec vitest run apps/web/github-auth.test.ts tests/api/github-app.test.ts packages/github/src/index.test.ts`

The controlled fixtures verify state tampering/replay, PKCE fields, secure cookies, CSRF, expiry/disconnect, user/installation intersection, tampered installation IDs, repository removal, user revocation, owner isolation, repo-scoped token refresh, credential-free HTTP responses and private source destination. RSA material is generated at test runtime and discarded; no real credential is committed.

The live gate remains: register/install an authorized test App, review its actual permission readback, sign in, select an owned private repository and inaccessible fork, revoke access, and verify the configured deployment's cookies/TLS and redacted evidence. Tests are evidence for implementation behavior; they are not a claim that an App has been registered or a private live account has been tested.

Primary references checked 2026-11-03: [GitHub user access token intersection and PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [scoped installation tokens and expiry](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
