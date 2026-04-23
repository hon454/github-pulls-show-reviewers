# ADR 0004: GitHub App Access Token Refresh

- Status: Accepted — amends [ADR 0003](./0003-github-app-device-flow.md) on token lifecycle
- Date: 2026-04-23

## Context

[ADR 0003](./0003-github-app-device-flow.md) shipped a GitHub App plus OAuth
Device Flow and explicitly accepted that *user-to-server tokens have no refresh
in a pure-client setting (the refresh endpoint requires a client secret)*. In
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
- `src/auth/refresh-coordinator.ts` de-duplicates in-flight refreshes per account
  and routes terminal outcomes to `markAccountInvalidated(id, "refresh_failed")`.
- Content scripts request refresh via `browser.runtime.sendMessage({ type:
  "refreshAccessToken", accountId })` when a reviewer fetch returns 401 and the
  account still has a refresh token.
- The storage schema carries `refreshToken`, `expiresAt`, and
  `refreshTokenExpiresAt` (`v4`, migrated from `v3`/`v2`).

Refresh outcomes are classified into two kinds:

- `terminal` — `bad_refresh_token`, `unauthorized_client`, `invalid_grant`,
  `unsupported_grant_type`, or HTTP 400/401 from the refresh endpoint. The
  account is marked invalidated with reason `refresh_failed` and the banner
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

- The storage schema migration (`v3` → `v4`) adds refresh-token fields in place;
  older schemas continue to migrate lazily on read.

## Links

- [ADR 0003](./0003-github-app-device-flow.md) — this ADR amends its "no
  refresh" constraint.
- `src/github/auth.ts::refreshAccessToken`
- `src/auth/refresh-coordinator.ts`
- `src/auth/account-token-refresh.ts::retryWithAccountRefresh`,
  `validateRepositoryAccessWithAccount`
