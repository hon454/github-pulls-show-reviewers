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
  A rejected retry waits for an already in-flight refresh of its generation
  before conditional invalidation, allowing a successful rotation to commit.
  The wait never holds the registry queue or waits on another generation.
- Reviewer summary and metadata services run requests/retries in background.
  Options recovery sends `{ type: "refreshAccessToken", accountId, generation }`;
  responses contain a non-secret revision and callers reread storage before a
  single retry. Missing accounts have no stale-token fallback. Retry invalidation
  sends the revision it actually used and commits only if it remains current.
- The storage schema carries `refreshToken`, `expiresAt`,
  `refreshTokenExpiresAt`, and an opaque `credentialGeneration` (`v4`, migrated
  from `v3`/`v2`). Sign-in and rotation issue a new UUID; initialization persists
  the non-secret `legacy` identity for missing generations so pre-migration
  snapshots, later reads and worker restarts agree until a real rotation.
- The background-only `accountMutations` queue owns initialization, registry
  repair, login identity resolution, duplicate consolidation, removal and auth
  commits. Options sign-in/removal route through validated runtime messages.
  Conditional auth commits recheck revision and registry membership inside this
  queue. GitHub HTTP runs outside it, so another account can progress while one
  refresh is stalled. This boundary is reused by later account-boundary work.

Refresh outcomes are classified into two kinds:

- `terminal` — `bad_refresh_token`, `unauthorized_client`, `invalid_grant`,
  `unsupported_grant_type`, or HTTP 400/401 from the refresh endpoint. The
  still-current generation is marked invalidated with reason `refresh_failed` and the banner
  prompts re-authentication.
- `transient` — 5xx, 429, network errors, or malformed bodies. The account is
  left valid and the row-level failure surfaces; rows self-heal on the next
  refresh attempt once GitHub recovers.

Diagnostics in the options page use the same retry-with-refresh path
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
- Existing local-storage visibility is unchanged. No service-worker keepalive
  guarantee is added: process termination between server rotation and durable
  local persistence remains an unrecoverable rotation window.

## Links

- [ADR 0003](./0003-github-app-device-flow.md) — this ADR amends its "no
  refresh" constraint.
- `src/github/auth.ts::refreshAccessToken`
- `src/auth/refresh-coordinator.ts`
- `src/auth/account-token-refresh.ts::retryWithAccountRefresh`,
  `validateRepositoryAccessWithAccount`
