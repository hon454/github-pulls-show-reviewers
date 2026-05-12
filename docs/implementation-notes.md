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
5. Send one `fetchPullReviewerMetadataBatch` message per page/account when the
   page-level metadata cache is cold or stale. The background reads the first
   REST pull-list page with the matched account token (or no token if none
   matches), returning requested user reviewers, requested teams, and author
   logins that can be reused across visible rows. Page metadata has a shorter
   freshness window than row summaries because re-review requests primarily
   change `requested_reviewers` / `requested_teams`.
6. Send a `fetchPullReviewerSummary` message for each uncached or stale row.
   Fresh cache hits render without refetching. Stale cache hits render the
   cached chips immediately, then revalidate in the background and rerender only
   the affected row when fresh data arrives. When the page-level metadata
   contains that pull request number, the background skips the per-row pull
   endpoint and reads only the reviews endpoint. If the pull number is absent
   from the batch result, the summary request falls back to the original per-row
   `pull + reviews` REST path.
   If no covering account is found, the first attempt still uses the no-token
   path so public repositories keep working without authentication. When that
   no-token metadata or summary fetch fails with an authentication, access,
   not-found, or rate-limit response, the content script retries once with a
   connected fallback account: first an account whose login matches the
   repository owner, then the only active account installed on that owner, and
   finally the sole active connected account if there is exactly one. Ambiguous
   owner-installation matches do not fallback. A successful fallback is reused
   for that owner during the page session; a failed fallback is reported as a
   signed-in failure so the banner can point to GitHub App access rather than
   asking the user to sign in again.
7. For ambiguous user reviewers that appear in both `requested_reviewers` and
   the latest non-`COMMENTED` review set (`APPROVED`, `CHANGES_REQUESTED`, or
   `DISMISSED`), read the pull request's issue events and compare ordering.
   When the latest `review_requested` event for that user is newer than the
   latest completed review, keep the user requested so the row shows the
   refresh badge. Otherwise, drop the stale requested marker so the row shows
   the completed review state. If this targeted issue-event lookup fails, fall
   back to the completed review state instead of labeling the reviewer as
   re-requested.
8. Render a single `Reviewers` section inline in the PR row metadata area. Each reviewer is an avatar chip. Requested reviewers keep the blue requested ring. Completed reviewers show a ring and badge derived from one `(isRequested, state)` mapping. Review selection prefers the latest non-`COMMENTED` review for a reviewer, falling back to the latest `COMMENTED` review only when no non-comment review exists. A still-requested reviewer with prior `APPROVED`, `CHANGES_REQUESTED`, or `DISMISSED` evidence shows the refresh badge only when the event ordering confirms a later re-request. Requested teams keep the text chip shape. User chip links follow the same primary axis as the ring color: blue-ring (still-requested) chips link to `review-requested:<login>`; colored-ring (completed) chips link to `reviewed-by:<login>`. Reviewer chip links use `is:pr is:open` searches by default.
9. On API errors, emit a signal to the banner aggregator; do not render
   row-level error text.
10. Re-run row processing when GitHub mutates the page or performs SPA
    navigation. Same-repository navigation/render events mark visible row
    summaries stale instead of trusting the active page-session cache forever.
    Existing-row DOM mutations use a lightweight row fingerprint so unrelated
    attribute changes do not trigger reviewer API requests. The fingerprint
    excludes extension-rendered reviewer nodes and GitHub's volatile relative
    timestamp nodes, so automatic time text updates do not refetch reviewers.

## Current limitations

- The extension still depends on GitHub metadata DOM structure.
- Cold rows on a typical first PR-list page use one pull-list metadata request
  plus one reviews request per uncached row. Filtered, searched, or older pages
  can still fall back to one pull request plus one reviews request for rows that
  are not present in the first REST pull-list page.
- Public-repository no-token access still depends on GitHub's unauthenticated REST availability and rate limits.
- PAT-era single-token settings are not migrated; users must sign in again with
  the GitHub App account flow.
- Browser support is intentionally limited to Chrome. The build and release
  flow target Chrome MV3, manual verification runs in Chrome, and Chrome Web
  Store packaging is the only distribution path. Edge, Brave, and Arc may run
  the Chromium MV3 output, but they are compatibility expectations rather than
  supported targets. Firefox support would need separate MV3 behavior checks,
  packaging validation, store guidance, and private-repository sign-in testing.
- User-facing copy is intentionally English-only. Adding localization later
  would require extracting manifest text into Chrome `_locales`, moving
  options-page React copy, access-banner guidance, and injected reviewer labels
  behind a translation boundary, then adding fixture coverage to keep localized
  pull-list rendering deterministic.

## Unit coverage gate

- `pnpm test:coverage` runs the Vitest unit suite with V8 coverage over
  `src/**/*.ts`.
- Coverage reports are emitted as terminal text and ignored local HTML output in
  `coverage/`.
- The gate starts near the measured v1.7.3 baseline: 85% statements, 80%
  branches, 90% functions, and 85% lines. The threshold is intentionally modest
  so reviewer-critical code cannot lose broad coverage silently while existing
  auth and background-worker gaps can be improved incrementally.

## Display preferences

- Stored under a separate `preferences` key in `browser.storage.local` (schema `version: 1`).
- `showStateBadge` (default `true`) toggles the SVG state badge on each avatar.
- `showReviewerName` (default `false`) switches each user chip between avatar-only and a rounded pill containing the avatar and `@login` text.
- `openPullsOnly` (default `true`) keeps reviewer chip links scoped to open pull requests. When disabled, links preserve the previous `is:pr <reviewer qualifier>` query so closed PRs can appear too.
- Preference changes rerender without invalidating the per-row reviewer cache — no extra GitHub requests are triggered.

## Request volume decision

- ADR: [0001 - Keep No-Token Support For Public Repositories](./adr/0001-keep-no-token-support-for-public-repositories.md)
- The current implementation keeps the REST-only public path and uses
  `GET /repos/{owner}/{repo}/pulls?per_page=100&state=all` as a page-level
  metadata hint before row summaries.
- The content script de-duplicates in-flight row fetches, caches each pull
  request summary for the active page session with freshness metadata, and
  caches the page-level metadata result per `owner/repo/account` with a shorter
  freshness window.
- Issue-event requests are targeted to ambiguous requested+completed reviewer
  overlaps only. Rows whose requested users do not overlap a latest
  non-`COMMENTED` review keep the lower-volume pull metadata plus reviews path.
- A GraphQL-first rewrite is not the next step because it would push the product away from the current no-token public-repository path and add a second transport model to maintain.
- If request volume remains the next bottleneck, the preferred follow-up is to
  make the REST batch smarter for filtered and paginated GitHub list pages
  before considering a broader API migration.

## Access banner classification

| Account state | Failure pattern                                      | Banner kind            | CTA              |
| ------------- | ---------------------------------------------------- | ---------------------- | ---------------- |
| Signed in     | 401 on any reviewer endpoint                         | `auth-expired`         | Sign in          |
| Signed in     | 404 / 403 with no rate-limit signal                  | `app-uncovered`        | Configure access |
| Signed in     | 429, or 403 with `x-ratelimit-remaining: 0`          | `auth-rate-limit`      | (passive wait)   |
| No account    | 429, or 403 with rate-limit signal                   | `unauth-rate-limit`    | Sign in          |
| No account    | 401, 403, or 404 without rate-limit signal           | `signin-required`      | Sign in          |
| Either        | Network / schema / unknown / empty endpoint envelope | (silent, console.warn) | —                |

Severity priority for cross-row resolution: `auth-expired` > `app-uncovered` >
`auth-rate-limit` > `unauth-rate-limit` > `signin-required`. The highest-priority
kind seen on a page wins.

Banner dismissal is keyed by `pathname + kind`, so dismissing one kind on a page
does not suppress a later, higher-priority kind on the same page.

For rate-limit kinds (`auth-rate-limit`, `unauth-rate-limit`), the GitHub
response's `x-ratelimit-limit / -remaining / -reset / -resource` headers ride
with the failure envelope (`ReviewerFetchFailure.rateLimit`) into the
aggregator, so the banner can report `(used/limit)` and a relative reset
time. Callers fall back segment-by-segment: missing limit/remaining omits the
usage clause, and a missing reset timestamp keeps the static reset copy. The
snapshot is in-memory only — it is never persisted.

## Proactive token refresh

- A recurring `chrome.alarms` job (15-minute period, 30-minute refresh threshold) pre-warms access tokens before the reactive 401 path is needed, and invalidates accounts whose refresh token has already expired.
- Design rationale, alternatives, and the revisit trigger live in [ADR 0005](./adr/0005-proactive-refresh.md).

## Stale GitHub App installation self-healing

- `resolveAccountForRepo` reads the locally cached installations snapshot, so a repo added to an existing installation outside the extension can look uncovered until the next manual `Refresh installations` click.
- `createSelfHealingAccountResolver` (`src/features/reviewers/account-resolution.ts`) wraps the resolution: when the cached lookup misses, it scans for accounts that own a `selected` installation on the same owner but do not list the repo, then sends a `refreshAccountInstallations` message to the background and re-runs the resolution.
- The background-side `createInstallationRefreshService` (`src/background/installation-refresh.ts`) holds the token, refreshes via `RefreshCoordinator` on 401, persists through `replaceInstallations`, and dedupes concurrent calls per `accountId`. Tokens never enter the content-script context.
- Each candidate is refreshed at most once per page session. A successful refresh writes to `account:installations:*`, which the existing `accountsChange` storage listener uses to clear the row cache and re-render covered rows transparently.
- Genuinely uncovered repos still flow into the `app-uncovered` /
  `signin-required` banner copy after the refresh attempt completes. When a
  connected fallback account is available, uncovered private repositories are
  reported through the signed-in `app-uncovered` path rather than the no-account
  sign-in path.

## Next implementation targets

- Extend the REST metadata batch to better cover searched, filtered, and older
  paginated GitHub PR list pages.
- Add more fixture-backed extension boot coverage for GitHub DOM variants.

## End-to-end banner coverage

- `tests/e2e/extension.spec.ts` covers two access-banner failure flows on the
  packaged MV3 build using fixture HTML with a `<main>` mount target:
  - Signed-out 429 with rate-limit headers — asserts the
    `unauth-rate-limit` copy, the `Sign in` CTA, and the relative reset time.
  - Signed-in 404 against a covered owner — seeds an account into
    `chrome.storage.local` from a chrome-extension page, then asserts the
    `app-uncovered` copy and the `Configure access` CTA pointing at the App
    installation URL.

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
