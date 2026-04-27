# Implementation Notes

## Current MVP behavior

- Settings store multiple connected GitHub accounts under a single versioned
  `settings` key. Each account carries a user-to-server token plus a cache of
  its GitHub App installations (`all` or `selected` with explicit full names).
- Device flow runs on the options page. Polling stops when the options tab
  closes; restarts are clean.
- Content scripts detect PR rows and dispatch a `fetchPullReviewerSummary`
  message to the background service worker. The background resolves the
  covering account per repo via the cached installations and performs the
  GitHub REST calls, so access tokens never enter the content-script
  execution context. No user-typed scope patterns.
- Row-level failures render an empty reviewer slot. A page-level banner surfaces
  one of five guidance states — token expired, App not installed, auth rate
  limit, unauthenticated rate limit, or sign-in required — chosen by severity
  priority across all row failures on the page.

## Runtime flow

1. Parse the current repository route from `window.location.pathname`.
2. Find PR rows with centralized GitHub selectors.
3. Extract the pull request number from the row id or primary pull request link.
4. Resolve the covering account for `owner/repo` via `resolveAccountForRepo`.
5. Send a `fetchPullReviewerSummary` message to the background service
   worker when the cache is cold. The background resolves the matched
   account's token (or no token if none matches), performs the GitHub REST
   calls, and returns the parsed summary or a typed error.
6. Render a single `Reviewers` section inline in the PR row metadata area. Each reviewer is an avatar chip. Requested reviewers keep the blue requested ring. Completed reviewers show a ring and badge derived from one `(isRequested, state)` mapping. Review selection prefers the latest non-`COMMENTED` review for a reviewer, falling back to the latest `COMMENTED` review only when no non-comment review exists. A still-requested reviewer with prior `APPROVED`, `CHANGES_REQUESTED`, or `DISMISSED` evidence shows the refresh badge instead of the prior state badge. Requested teams keep the text chip shape. User chip links follow the same primary axis as the ring color: blue-ring (still-requested) chips link to `review-requested:<login>`; colored-ring (completed) chips link to `reviewed-by:<login>`. Reviewer chip links use `is:pr is:open` searches by default.
7. On API errors, emit a signal to the banner aggregator; do not render
   row-level error text.
8. Re-run row processing when GitHub mutates the page or performs SPA navigation.

## Current limitations

- The extension still depends on GitHub metadata DOM structure.
- API requests are still one pull request plus one reviews request per uncached row.
- Public-repository no-token access still depends on GitHub's unauthenticated REST availability and rate limits.
- PAT-era single-token settings are not migrated; users must sign in again with
  the GitHub App account flow.

## Display preferences

- Stored under a separate `preferences` key in `browser.storage.local` (schema `version: 1`).
- `showStateBadge` (default `true`) toggles the SVG state badge on each avatar.
- `showReviewerName` (default `false`) switches each user chip between avatar-only and a rounded pill containing the avatar and `@login` text.
- `openPullsOnly` (default `true`) keeps reviewer chip links scoped to open pull requests. When disabled, links preserve the previous `is:pr <reviewer qualifier>` query so closed PRs can appear too.
- Preference changes rerender without invalidating the per-row reviewer cache — no extra GitHub requests are triggered.

## Request volume decision

- ADR: [0001 - Keep No-Token Support For Public Repositories](./adr/0001-keep-no-token-support-for-public-repositories.md)
- `v1.0.0` keeps the current `pull + reviews` REST model for cold rows.
- The current implementation already de-duplicates in-flight row fetches and caches each pull request summary for the active page session, so the immediate duplication risk is contained.
- A GraphQL-first rewrite is not the next step because it would push the product away from the current no-token public-repository path and add a second transport model to maintain.
- If request volume becomes the next real bottleneck after launch, the preferred follow-up is a page-level batch strategy on the existing REST path before considering a broader API migration.

## Access banner classification

| Account state | Failure pattern                                           | Banner kind          | CTA              |
| ------------- | --------------------------------------------------------- | -------------------- | ---------------- |
| Signed in     | 401 on any reviewer endpoint                              | `auth-expired`       | Sign in          |
| Signed in     | 404 / 403 with no rate-limit signal                       | `app-uncovered`      | Configure access |
| Signed in     | 429, or 403 with `x-ratelimit-remaining: 0`               | `auth-rate-limit`    | (passive wait)   |
| No account    | 403, 429, or any rate-limit signal                        | `unauth-rate-limit`  | Sign in          |
| No account    | 404                                                       | `signin-required`    | Sign in          |
| Either        | Network / schema / unknown / empty endpoint envelope      | (silent, console.warn) | —             |

Severity priority for cross-row resolution: `auth-expired` > `app-uncovered` >
`auth-rate-limit` > `unauth-rate-limit` > `signin-required`. The highest-priority
kind seen on a page wins.

Banner dismissal is keyed by `pathname + kind`, so dismissing one kind on a page
does not suppress a later, higher-priority kind on the same page.

## Proactive token refresh

- A recurring `chrome.alarms` job (15-minute period, 30-minute refresh threshold) pre-warms access tokens before the reactive 401 path is needed, and invalidates accounts whose refresh token has already expired.
- Design rationale, alternatives, and the revisit trigger live in [ADR 0005](./adr/0005-proactive-refresh.md).

## Next implementation targets

- Collapse request volume further where practical.
- Add more fixture-backed extension boot coverage for GitHub DOM variants.

## Device flow

- Polling lives on the options page because MV3 service workers unload on idle.
- `POST /login/oauth/access_token` uses the `urn:ietf:params:oauth:grant-type:device_code` grant type. No `client_secret` is required or sent.
- On `slow_down`, the interval bumps by 5 seconds.
- On `expired_token` or the local clock passing `expires_at`, the panel offers a
  retry that requests a fresh device code.

## Registering a personal GitHub App for development

1. Create a new GitHub App on your account. Set Device Flow to **Enabled** and
   Repository permissions to `Pull requests: Read` only.
2. Copy the Client ID and App slug into `.env.local`:

```bash
WXT_GITHUB_APP_CLIENT_ID=<your-client-id>
WXT_GITHUB_APP_SLUG=<your-app-slug>
WXT_GITHUB_APP_NAME=<optional display name>
```

3. Run `pnpm dev` and open the options page to exercise the device flow against
   your personal App.
