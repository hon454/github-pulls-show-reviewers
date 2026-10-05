# ADR 0004: GitHub App Access Token Refresh

- Status: Accepted — amends [ADR 0003](./0003-github-app-device-flow.md) on token lifecycle
- Date: 2026-04-23

## Context

[ADR 0003](./0003-github-app-device-flow.md) shipped a GitHub App plus OAuth
Device Flow and explicitly accepted that _user-to-server tokens have no refresh
in a pure-client setting (the refresh endpoint requires a client secret)_. In
practice GitHub's OAuth device-flow refresh grant works without a client secret
when the app is configured for device flow, which leaves access-token expiry as
an avoidable re-authentication tax: before this change, the options page surfaced
a revoked-style prompt and every PR row silently failed every eight hours until
the user signed in again.

## Decision

Exchange the stored `refresh_token` for a new access token inside the MV3
service worker before invalidating an account.

- `src/github/auth.ts::refreshAccessToken` posts `grant_type=refresh_token` and
  classifies the response.
- `src/auth/refresh-coordinator.ts` compares the credential generation actually
  used with current storage before recovery. Delayed failures reuse newer valid
  credentials, including after an earlier refresh promise has settled. Current
  concurrent failures share one in-flight refresh per account/generation.
  Recovery/invalidation admission is recorded before the first storage await.
  A rejected retry waits for earlier recovery of its generation before
  conditional invalidation, allowing a successful rotation to commit even when
  recovery was still reading storage. Later recovery of that generation waits
  for invalidation, then rereads current state. Waits never hold the registry
  queue; another generation's HTTP remains independent.
- Reviewer summary/metadata, diagnostics and installation services run
  requests/retries in background. UI callers request those operations, never a
  token refresh or credential-bearing callback. The old `refreshAccessToken`
  and invalidation runtime endpoints are removed by
  [ADR 0008](./0008-background-credentials-and-ui-capabilities.md).
  Background retry helpers reread current accounts before a single retry.
  Missing accounts have no stale-token fallback; retry invalidation commits
  only if the revision actually used remains current.
- The storage schema carries `refreshToken`, `expiresAt`,
  `refreshTokenExpiresAt`, and an opaque `credentialGeneration` (`v4`, migrated
  from `v3`/`v2`). Sign-in and rotation issue a new UUID; initialization persists
  the non-secret `legacy` identity for missing generations so pre-migration
  snapshots, later reads and worker restarts agree until a real rotation.
- The background-only `accountMutations` queue owns initialization, registry
  repair, account identity resolution (by GitHub user id since #246),
  duplicate consolidation, removal and auth commits. Background device flow and validated options removal capabilities
  reuse this owner.
  Conditional auth commits recheck revision and registry membership inside this
  queue. GitHub HTTP runs outside it, so another account can progress while one
  refresh is stalled. This boundary is reused by later account-boundary work.
- Amendment (2026-10-05, #248): repair never deletes stored credentials it
  cannot parse. An unreadable account record is kept unchanged and read as an
  invalidated account with no credentials until the user signs in again or
  removes it, and an unreadable index is rebuilt from the stored records. The
  owner initializes once per worker activation and re-verifies after any failed
  owner operation.

Refresh outcomes are classified into two kinds:

- `terminal` — `bad_refresh_token`, `unauthorized_client`, `invalid_grant`,
  `unsupported_grant_type`, or HTTP 400/401 from the refresh endpoint. The
  still-current generation is marked invalidated with reason `refresh_failed` and the banner
  prompts re-authentication.
- `transient` — 5xx, 429, network errors, malformed bodies, or a request that
  exceeds the 15-second credential request timeout
  (`src/shared/credential-deadline.ts`, #245). The account is
  left valid and the row-level failure surfaces; rows self-heal on the next
  refresh attempt once GitHub recovers. A timed-out refresh releases the
  coordinator's in-flight entry, so a later 401 for that generation starts a
  new exchange instead of joining the abandoned one. A response read before
  the timeout is kept, because GitHub may already have rotated the refresh
  token for it. Known limitation: refresh tokens are single-use, so a refresh
  GitHub completed but that did not arrive within the bound is lost like an
  interrupted rotation. The next attempt may then fail terminally and require
  re-authentication. This trade-off is accepted so a stalled exchange cannot
  hold every later recovery for that generation.

Only the refresh HTTP exchange is classified this way. After a successful
rotation, the old refresh token may already be retired, so a rejected storage
commit is not a transient refresh failure. The coordinator retries the same
generation-conditional commit a bounded number of times with the in-memory
tokens. Each attempt is a separate owner commit; it starts no new HTTP, and the
waits between attempts stay outside the registry queue while same-generation
callers keep joining that rotation. If every attempt fails it rejects with
`RefreshCommitError`. A later same-generation invalidation waits for an earlier
recovery to settle, whether that recovery resolves or rejects, and then makes
its own conditional commit.

Diagnostics requested by options use the same background retry-with-refresh path
(`validateRepositoryAccessWithAccount`) so "Check matched account" mirrors
runtime behavior — an expired access token is not reported as a failure while
the runtime recovers silently.

## Rationale

- Users stay signed in across 8-hour access-token expiry without acting.
- Revoked authorization and expired refresh tokens still surface clearly: the
  banner and options page prompt re-authentication when `refresh_failed` is
  stored.
- Service-worker-side coordination avoids thundering-herd refreshes when multi-
  ple PR rows hit 401 simultaneously — the first request wins and the others
  reuse the outcome.
- Diagnostics that match runtime behavior prevent user confusion when the
  "Check matched account" button reports a failure the extension silently
  recovered from.

## Consequences

### Positive

- 8-hour expiry is invisible to users unless the refresh token itself expires
  or is revoked.
- Diagnostics no longer emit false negatives for accounts with stale access
  tokens.
- Terminal classification in `refreshAccessToken` now covers non-2xx responses
  that still carry an OAuth error envelope, so revoked authorization is
  detected on the first failed exchange instead of after repeated transient
  classifications.

### Negative

- Adds a stored refresh token in `browser.storage.local`. Privacy policy and
  Chrome Web Store submission copy reflect this.
- A GitHub-side outage during refresh surfaces as per-row failures without
  invalidating the account — same user-visible behavior as before, with the
  addition that rows self-heal once GitHub recovers.

### Neutral

- Background initialization and subsequent owner operations serialize legacy
  migration/repair. Queries can read old schemas but never write a stale index.
- ADR 0008 restricts content storage and removes credentials from UI application
  paths. It adds no service-worker keepalive guarantee: process termination
  between server rotation and durable local persistence remains an
  unrecoverable rotation window.

## Links

- [ADR 0003](./0003-github-app-device-flow.md) — this ADR amends its "no
  refresh" constraint.
- `src/github/auth.ts::refreshAccessToken`
- `src/auth/refresh-coordinator.ts`
- `src/background/account-request.ts::createAccountRequest`,
  `src/auth/account-token-refresh.ts::validateRepositoryAccessWithAccount`
