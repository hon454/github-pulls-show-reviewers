# Implementation Notes

## Current MVP behavior

- Settings store multiple connected GitHub accounts under a single versioned
  `settings` key. Each account carries a user-to-server token plus a cache of
  its GitHub App installations. `all` installations cover the owner directly;
  `selected` installations carry an explicit repository snapshot with both
  full names and a `complete` / `truncated` completeness marker.
- Device flow runs on the options page. Polling stops when the options tab
  closes; restarts are clean.
- Content scripts detect PR rows and dispatch a `fetchPullReviewerSummary`
  message to the background service worker. The background resolves the
  covering account per repo via the cached installations and performs the
  GitHub REST calls, so access tokens never enter the content-script
  execution context. No user-typed scope patterns.
- Row-level failures do not render inline error text. A page-level banner
  aggregates repeated failures into one of six guidance states — token expired,
  App not installed, auth rate limit, unauthenticated rate limit, sign-in
  required, or reviewer data temporarily unavailable — chosen by severity
  priority across all row failures on the page. Successful empty results stay
  visually empty, while failed background revalidation keeps stale reviewer
  chips visible.
- The options page repository diagnostics show structured evidence for reviewer
  access checks: matched account, auth mode, GitHub App installation coverage,
  endpoint result, and any rate-limit headers GitHub returned for the diagnostic
  request. Rate-limit snapshots are diagnostic output only and are not persisted.

## Module boundaries

- `src/github/api.ts` remains the stable import facade for GitHub API callers.
  Its implementation is split under `src/github/api/`: `schemas.ts` owns zod
  response parsing, `request.ts` owns authenticated headers and validated REST
  pagination, `reviewer-summary.ts` owns page metadata and reviewer-state
  aggregation, `diagnostics.ts` owns token/repository validation and stable
  API error classification, and `types.ts` owns the shared contracts and errors.
  Repository diagnostic view models own localized explanations.
- `src/features/reviewers/index.ts` remains the content-script facade.
  `page-controller.ts` coordinates route and row work,
  `page-metadata.ts` owns the short-lived page metadata cache and in-flight
  request deduplication, `row-lifecycle.ts` owns row fingerprints and GitHub DOM
  mutation handling, `fallback-account.ts` owns page-session fallback resolution
  reuse, and `runtime-requests.ts` owns cancelable background messaging.
- The facades intentionally export only the pre-existing application contracts.
  Focused boundary tests exercise pagination validation and budgets, metadata
  freshness and fallback behavior, fallback lookup deduplication, cancelable
  runtime requests, and extension-owned versus GitHub-owned DOM mutations.

## Runtime flow

1. Parse the current repository route from `window.location.pathname`.
2. Find PR rows with centralized GitHub selectors.
3. Extract the pull request number from the row id or a centralized pull
   request link selector. The selector prefers GitHub's `Link--primary` class
   and falls back to `js-navigation-open` pull links for markup variants where
   the title link keeps navigation behavior but loses the primary-link class.
4. Resolve the covering account for `owner/repo` via
   `resolveAccountForRepo`. Internally, account coverage distinguishes
   definite coverage from a truncated selected-installation snapshot that may
   still cover the repository.
5. Send one `fetchPullReviewerMetadataBatch` message per page/account when the
   page-level metadata cache is cold or stale. The content script includes the
   visible pull numbers in that message. The background reads the first REST
   pull-list page with the matched account token (or no token if none matches)
   and follows validated `Link: rel="next"` pagination for up to three REST
   pages total, stopping earlier when those visible numbers are covered or
   pagination ends. The response returns requested user reviewers, requested
   teams, and author logins that can be reused across visible rows. Page
   metadata has a shorter freshness window than row summaries because
   re-review requests primarily change `requested_reviewers` /
   `requested_teams`.
6. Send a `fetchPullReviewerSummary` message for each uncached or stale row.
   Fresh cache hits render without refetching. Stale cache hits render the
   cached chips immediately, then revalidate in the background and rerender only
   the affected row when fresh data arrives. Network-backed summary messages
   enter a four-slot, abort-aware FIFO queue after cache lookup and same-row
   in-flight deduplication. A failed revalidation preserves those stale chips
   and reports through the page-level banner. When the page-level metadata
   contains that pull request number, the background skips the per-row pull
   endpoint and reads only the reviews endpoint. If the pull number is absent
   from a successful batch result, the summary request falls back to the
   original per-row `pull + reviews` REST path. If the page-level metadata batch
   finally fails with an authentication, access, not-found, or rate-limit
   failure after eligible fallback-account retry, same-page row fallback is
   suppressed and the existing page banner receives that failure once.
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
   `DISMISSED`), read up to two pages of the pull request's issue events and
   compare ordering. When the latest `review_requested` event for that user
   within that bounded lookup is newer than the latest completed review, keep
   the user requested so the row shows the refresh badge. Otherwise, drop the
   stale requested marker so the row shows the completed review state. If this
   targeted issue-event lookup fails, or the confirming event is beyond the
   two-page bound, fall back to the completed review state instead of labeling
   the reviewer as re-requested.
8. Render a single `Reviewers` section inline in the PR row metadata area. The
   mount lives in an extension-owned `inline-flex` metadata container instead
   of GitHub's `d-none d-md-inline-flex` wrapper. Standard desktop placement and
   chip styling stay unchanged, while narrow desktop and split-window layouts
   keep reviewer metadata visible without forcing GitHub's hidden row metadata
   back into view. Repeated processing moves an existing mount into that
   container and removes duplicate roots. Each reviewer is an avatar chip.
   Requested reviewers keep the blue requested ring. Completed reviewers show
   a ring and badge derived from one `(isRequested, state)` mapping. Review
   selection prefers the latest non-`COMMENTED` review for a reviewer, falling
   back to the latest `COMMENTED` review only when no non-comment review exists.
   A still-requested reviewer with prior `APPROVED`, `CHANGES_REQUESTED`, or
   `DISMISSED` evidence shows the refresh badge only when the event ordering
   confirms a later re-request. Requested teams keep the text chip shape. User
   chip links follow the same primary axis as the ring color: blue-ring
   (still-requested) chips link to `review-requested:<login>`; colored-ring
   (completed) chips link to `reviewed-by:<login>`. Reviewer chip links use
   `is:pr is:open` searches by default.
9. On API errors, emit a signal to the banner aggregator; do not render
   row-level error text. Network, schema, and unknown failures use the generic
   reviewer-unavailable state with a same-page reload link. Repeated failures
   are deduplicated by the aggregator, and a successful empty reviewer summary
   does not emit any failure state.
10. Re-run row processing when GitHub mutates the page or performs SPA
    navigation. Same-repository navigation/render events mark visible row
    summaries stale instead of trusting the active page-session cache forever.
    The observer stays rooted at `document.body` with `subtree`, `childList`,
    and `characterData` coverage so rows inserted under current, future, or
    fallback list containers remain discoverable. Attribute observation is
    filtered to `class`, `href`, and `id`, which determine row/metadata
    selector matches and pull identity. Each observer delivery collects added
    and mutated PR rows in sets, then fingerprints each affected existing row
    at most once. The fingerprint excludes extension-rendered reviewer nodes
    and GitHub's volatile relative timestamp nodes; mutations inside those
    subtrees are rejected before cloning metadata. Same-repository route events
    remain the fallback for full-page GitHub renders.

## Mutation observation decision

The deterministic `github-pulls-mutation-stress.html` fixture emits one
synchronous burst containing 20 mutations each of unrelated link/page
attributes, relative-time text replacement, row-local subtree additions outside
metadata, and page-local subtree additions.

The Vitest lifecycle test records observer callbacks, delivered records,
fingerprint calculations, and `processRow` calls. The controller test records
the actual background runtime requests and confirms the same burst emits no
metadata or reviewer-summary request.

| Work per synchronous stress burst | Before | After |
| --------------------------------- | -----: | ----: |
| Observer callbacks                |      1 |     1 |
| Delivered mutation records        |    100 |    60 |
| Row fingerprint calculations      |     60 |     1 |
| `processRow` calls                |      0 |     0 |
| Reviewer API requests             |      0 |     0 |

The retained body boundary trades a small amount of cheap mutation
classification for reliable discovery of added rows and fallback mount
variants without encoding GitHub's current list-container hierarchy. Filtering
attributes to selector- and identity-relevant names removes the 40 unrelated
attribute records in the fixture; row-set batching reduces duplicate
fingerprint work by 59 of 60 calculations.

`childList` and `characterData` remain enabled because review-request metadata
can change through either form. Added rows are processed directly, while
changed metadata invalidates and processes its existing row once. Reviewer
roots and volatile relative-time elements remain excluded from fingerprint
input, and `wxt:locationchange`, `popstate`, `turbo:render`, and `pjax:end`
continue to force route refreshes.

## Current limitations

- The extension still depends on GitHub metadata DOM structure.
- Cold rows use one pull-list metadata request, additional pull-list pages only
  when visible pull numbers are not covered by the first REST page, and one
  reviews request per uncached row. Very old filtered or searched pages can
  still fall back to one pull request plus one reviews request for visible rows
  if pagination ends before matching metadata is found.
- Public-repository no-token access still depends on GitHub's unauthenticated REST availability and rate limits.
- PAT-era single-token settings are not migrated; users must sign in again with
  the GitHub App account flow.
- Browser support is intentionally limited to Chrome. The build and release
  flow target Chrome MV3, manual verification runs in Chrome, and Chrome Web
  Store packaging is the only distribution path. Edge, Brave, and Arc may run
  the Chromium MV3 output, but they are compatibility expectations rather than
  supported targets. Firefox support would need separate MV3 behavior checks,
  packaging validation, store guidance, and private-repository sign-in testing.
- Chrome metadata, options/auth, and repository diagnostics use the five bundled
  catalogs. Content reviewer labels and access banners remain English until
  their separate integration; no runtime translation service is used.

## Unit coverage gate

- `pnpm test:coverage` runs the Vitest unit suite with V8 coverage over
  `src/**/*.ts`, `entrypoints/**/*.ts`, and `entrypoints/**/*.tsx`. Generated
  WXT output under `.output/` and `.wxt/` is excluded from the report.
- Coverage reports are emitted as terminal text and ignored local HTML output in
  `coverage/`.
- The expanded v1.13.0 baseline is 92.11% statements, 88.31% branches, 96.61%
  functions, and 92.11% lines overall. Entrypoints measure 79.68% statements,
  92.85% branches, 87.50% functions, and 79.68% lines: `content.ts`,
  `background.ts`, and the options entrypoint modules are present in the
  report; `options/main.tsx` is a zero-coverage bootstrap module because the
  unit suite mounts `OptionsPage` directly.
- The enforced global thresholds are 90% statements, 85% branches, 95%
  functions, and 90% lines. Each is rounded down only slightly from the
  expanded baseline, retaining a meaningful branch gate while allowing the
  known unexecuted options bootstrap and existing incremental coverage gaps.

## Display preferences

- Stored under a separate `preferences` key in `browser.storage.local` (schema `version: 1`).
- `language` (default `auto`) stores the UI locale override. Missing or invalid language values recover to `auto` without resetting valid display choices.
- `showStateBadge` (default `true`) toggles the SVG state badge on each avatar.
- `showReviewerName` (default `false`) switches each user chip between avatar-only and a rounded pill containing the avatar and `@login` text.
- `openPullsOnly` (default `true`) keeps reviewer chip links scoped to open pull requests. When disabled, links preserve the previous `is:pr <reviewer qualifier>` query so closed PRs can appear too.
- Preference changes rerender without invalidating the per-row reviewer cache — no extra GitHub requests are triggered.

## Request volume decision

- ADR: [0001 - Keep No-Token Support For Public Repositories](./adr/0001-keep-no-token-support-for-public-repositories.md)
- The current implementation keeps the REST-only public path and uses one
  page-level metadata batch per fresh `owner/repo/account/visible pull numbers`
  set before row summaries. That batch starts with
  `GET /repos/{owner}/{repo}/pulls?per_page=100&state=all`.
- For searched, filtered, and paginated GitHub list pages, the content script
  sends visible pull numbers so the background can follow REST pagination until
  those numbers are covered. The hard budget is three pull-list pages total
  (`PULL_METADATA_BATCH_PAGE_BUDGET`), or up to 300 pull records at GitHub's
  documented `per_page=100` maximum.
- Rows covered by page metadata skip the per-row pull endpoint and fetch only
  reviews, so the cold-row budget is the shared pull-list metadata batch plus
  one `GET /repos/{owner}/{repo}/pulls/{n}/reviews?per_page=100` request per
  uncached visible row, with additional review pages followed only when GitHub
  returns review pagination links.
- If a successful metadata batch does not cover an older visible pull within
  the three-page budget, that row falls back to the original per-row
  `pull + reviews` REST path. This fallback is intentional: it preserves
  reviewer visibility for older filtered/search results without making the
  shared no-token metadata discovery unbounded.
- The content script de-duplicates in-flight row fetches, caches each pull
  request summary for the active page session with freshness metadata, and
  caches the page-level metadata result per `owner/repo/account` and visible
  pull-number set with a shorter freshness window. When page metadata already
  covers a row, row-level duplicate pull endpoint fetches are avoided.
- Reviewer-summary runtime messages use
  `REVIEWER_SUMMARY_CONCURRENCY_LIMIT = 4`. The queue is FIFO in the order rows
  reach the network boundary, so the initial DOM-order scan remains ordered when
  its shared metadata request resolves. Fresh and stale cache entries are read
  and rendered before the queue. Duplicate processing of the same pull joins
  the existing in-flight promise instead of consuming another slot. Route
  changes, account changes, and content-script invalidation abort both active
  and queued row work; queued work never sends a background message.
- The concurrency choice is backed by the deterministic 100 ms-per-summary
  timing model in `tests/reviewer-request-scheduler.test.ts`. The fixture uses a
  normal 25-row list and an 8-row non-contiguous filtered list. “Before” models
  the previous unbounded dispatch; “after” uses the four-slot scheduler. These
  are request-shape measurements, not a production GitHub latency SLA:

  | Fixture         | Summary requests before → after | Peak concurrency before → after | First render-ready latency before → after | All render-ready latency before → after |
  | --------------- | ------------------------------- | ------------------------------- | ----------------------------------------- | --------------------------------------- |
  | 25 rows         | 25 → 25                         | 25 → 4                          | 100 ms → 100 ms                           | 100 ms → 700 ms                         |
  | Filtered 8 rows | 8 → 8                           | 8 → 4                           | 100 ms → 100 ms                           | 100 ms → 200 ms                         |

  Four slots reduce the 25-row burst by 84% while preserving time to the first
  result. Under the same model, a two-slot limit would need 13 waves for 25
  rows, while six slots would reduce completion to five waves at the cost of
  50% more simultaneous traffic than four. Four therefore keeps useful
  parallelism without leaving the browser's connection pool as the only burst
  control. Packaged-extension E2E coverage independently delays all 25 reviews
  endpoints and asserts a peak of four active requests.

- The limit changes request shape, not request count or authentication
  semantics. Each no-token public request remains the first attempt when no
  covering account exists. An eligible authenticated fallback retry enters the
  same queue as a second, sequential attempt for that row.
- Issue-event requests are targeted to ambiguous requested+completed reviewer
  overlaps only, and follow at most two GitHub API issue-event pages
  (`REVIEW_REQUEST_EVENT_PAGE_BUDGET`). Rows whose requested users do not
  overlap a latest non-`COMMENTED` review keep the lower-volume pull metadata
  plus reviews path. If a confirming `review_requested` event is unavailable
  within the two-page bound, the row uses the completed review state rather
  than an uncertain refresh badge.
- A GraphQL-first rewrite is not the next step because it would push the product away from the current no-token public-repository path and add a second transport model to maintain.
- If request volume remains the next bottleneck, the preferred follow-up is to
  tune the three-page REST pagination bound with fixture-backed evidence before
  considering a broader API migration.

## Access banner classification

| Account state | Failure pattern                                      | Banner kind             | CTA              |
| ------------- | ---------------------------------------------------- | ----------------------- | ---------------- |
| Signed in     | 401 on any reviewer endpoint                         | `auth-expired`          | Sign in          |
| Signed in     | 404 / 403 with no rate-limit signal                  | `app-uncovered`         | Configure access |
| Signed in     | 429, or 403 with `x-ratelimit-remaining: 0`          | `auth-rate-limit`       | (passive wait)   |
| No account    | 429, or 403 with rate-limit signal                   | `unauth-rate-limit`     | Sign in          |
| No account    | 401, 403, or 404 without rate-limit signal           | `signin-required`       | Sign in          |
| Either        | Network / schema / unknown / empty endpoint envelope | `reviewers-unavailable` | Reload page      |

Severity priority for cross-row resolution: `auth-expired` > `app-uncovered` >
`auth-rate-limit` > `unauth-rate-limit` > `signin-required` >
`reviewers-unavailable`. The highest-priority kind seen on a page wins.

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
- Selected-installation snapshots record whether GitHub pagination completed.
  When the local page ceiling is reached while a `next` link still exists, the
  snapshot is marked `truncated`. A repository absent from a truncated snapshot
  is treated as maybe covered, so the extension uses that account token and lets
  the real repository API response decide access instead of silently falling
  back to uncovered guidance.
- Authenticated installation pagination follows `next` links only when they
  resolve to the exact HTTPS `api.github.com` origin and the endpoint pathname
  that issued the response. A malformed or rejected `next` target is never sent
  the OAuth header and leaves the result marked `truncated`, so an incomplete
  installation or selected-repository snapshot cannot be persisted as complete.
- Account installation-list pagination is stricter: if the account-level
  `/user/installations` list hits the local page ceiling while a `next` link
  still exists, the refresh fails without replacing the previous installation
  snapshot because omitted installations cannot be tied to an owner.
- `createSelfHealingAccountResolver` (`src/features/reviewers/account-resolution.ts`) wraps the resolution: when a complete cached selected-installation lookup misses, it scans for accounts that own a `selected` installation on the same owner but do not list the repo, then sends a `refreshAccountInstallations` message to the background and re-runs the resolution.
- The background-side `createInstallationRefreshService` (`src/background/installation-refresh.ts`) holds the token, refreshes via `RefreshCoordinator` on 401, persists through `replaceInstallations`, and dedupes concurrent calls per `accountId`. Tokens never enter the content-script context.
- Each candidate is refreshed at most once per page session. A successful refresh writes to `account:installations:*`, which the existing `accountsChange` storage listener uses to clear the row cache and re-render covered rows transparently.
- Genuinely uncovered repos still flow into the `app-uncovered` /
  `signin-required` banner copy after the refresh attempt completes. When a
  connected fallback account is available, uncovered private repositories are
  reported through the signed-in `app-uncovered` path rather than the no-account
  sign-in path.
- Options diagnostics uses the same coverage resolution and includes an
  incomplete selected-installation snapshot warning alongside the matched
  account access result.

## Next implementation targets

- Add more fixture-backed extension boot coverage for GitHub DOM variants.

## End-to-end banner coverage

- `tests/e2e/extension.spec.ts` covers access-banner failure flows on the
  packaged MV3 build using fixture HTML with a `<main>` mount target:
  - Signed-out 429 with rate-limit headers — asserts the
    `unauth-rate-limit` copy, the `Sign in` CTA, and the relative reset time.
  - Signed-in 404 against a covered owner — seeds an account into
    `chrome.storage.local` from a chrome-extension page, then asserts the
    `app-uncovered` copy and the `Configure access` CTA pointing at the App
    installation URL.
  - Unexpected reviewer schema failure — asserts the deduplicated page-level
    unavailable copy, accessible status semantics, and same-page reload link.
  - Failed background revalidation — first renders reviewer chips from a
    successful response, then verifies those stale chips remain visible beside
    the unavailable banner when the next response fails schema validation.

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

## Localization foundation

Five canonical Chrome catalogs under `public/_locales/` are statically bundled
by the pure `src/i18n/` formatter. English is the fallback. Auto detection reads
Chrome's UI language; an explicit local preference overrides extension UI only.
Chrome-owned manifest metadata follows Chrome independently. The shared locale
store owns one local-storage listener while subscribed, safely orders hydration
against events and writes, and exposes React and DOM adapters with disposal.
Language is presentation state; no translated strings belong in reviewer caches,
request keys or technical error evidence. Options and diagnostics integration is
implemented in #148–#149; reviewer and access-banner integration is implemented
in #150. The full API, key
ownership, migration, error
and render-only rules are in
[ADR 0006](./adr/0006-bundled-localization-and-render-only-language.md).

Validate catalogs with the i18n unit tests and emitted metadata with
`pnpm build && pnpm verify:locales`. No release or publishing behavior changes.

## Options language integration

- The options root hydrates the shared locale store before mounting, then sets
  its own HTML language and translated document title. English HTML defaults
  contain readable text, never unresolved Chrome message references.
- The labelled selector offers Auto (Chrome language) and five native language
  names. It commits after a successful local save, announces a failure while
  retaining the previous selection, and receives changes from other options
  tabs through the shared store. Unsupported Chrome languages fall back to
  English. Chrome-owned metadata remains independent of this selector.
- The parent retains the device-flow controller across language changes. Its
  state stores phase, code, URLs and timestamps; known DeviceFlowError codes
  select translated guidance at render time. Unknown failures use a translated
  fallback instead of displaying raw external exception prose. Cancellation
  also ignores delayed failures. Poll intervals, credentials, account order,
  permission scope and refresh behavior are unchanged.
- Device codes, verification URLs, account identifiers, product/App names and
  `Pull requests: Read` remain literal. Expiry is formatted with the selected
  BCP 47 locale and the user's existing timezone; UTC instants are not changed.
- Display saves and account refresh/remove/load status keep keys/actions, not
  translated sentences. Changing language reformats visible status without
  repeating work. Preference writes within one context are serialized so
  overlapping language/display changes merge against the latest saved record.
- `DiagnosticsPanel` renders structured data with the parent translator. The
  parent never keys or remounts the subtree by locale, so repository input and
  active operations survive. Layout wraps long identifiers and actions at 360px.
- Regression coverage includes a real isolated Chrome two-tab language switch,
  persisted selection after reload, five-language 360px/desktop layout checks,
  pending authentication/refresh request counts, error rerendering, timezone
  formatting, native label associations and existing English behavior.

## Diagnostic language and evidence

- Repository validation keeps locale-independent `outcome`, `authMode`, repository,
  pull number and primary HTTP/rate-limit evidence. The additive `failures` array
  retains both failed reviewer endpoints and distinguishes HTTP, schema, network
  and unknown failures. Its entries contain only kind, endpoint, status and
  rate-limit scalars; no tokens, request objects, raw payloads or schema issues.
- Existing English `message` strings remain a compatibility field for internal
  callers. The options presentation never parses or displays them. Pure view
  models format every outcome and all coverage/working/input/error states from
  `diagnostics_` messages in the five bundled catalogs.
- Local uncovered/truncated installation snapshots remain separate from endpoint
  results. HTTP 403/404 guidance describes denied or unavailable access and asks
  users to verify the repository and App permissions; it does not claim that the
  repository is definitely private or that an installation is definitely missing.
- Repository names, logins, pull numbers, methods, API paths, HTTP statuses and
  rate-limit resource names remain literal. Quotas preserve their numeric values;
  reset epochs still display ISO date/time rounded down to the minute with a
  visible UTC suffix. Field labels and complete guidance sentences are translated.
- The panel stores diagnostic data and only the matched account login, not an
  account token or translated view model. Language changes rerender existing data,
  including running operations, without validation, token refresh or account
  resolution calls. Busy guards and matched/no-token input parsing are unchanged.
- Network exceptions without endpoint metadata show a localized generic API
  request label alongside the known repository and checked pull number; the UI
  never invents a failing path or HTTP status. List network/schema failures retain
  the known list endpoint. Unknown errors use actionable localized fallback copy
  rather than raw exception messages.
- Regression coverage includes all ten outcomes in five locales, both auth modes,
  dual endpoint failures, partial and exhausted quota evidence, UTC reset values,
  safe schema/network/unknown errors, and language changes during/after both
  matched-account and no-token requests with unchanged API call counts.

## Reviewer and access-banner language integration

- Reviewer and banner DOM roots share the context locale store. Each feature
  subscribes once; the store owns a single locale storage listener. Reviewer
  subscriptions stop outside PR-list routes and on context invalidation; banner
  teardown releases its subscription on route changes and invalidation.
- `page-controller.ts` compares only display fields for preference-driven data
  refresh. A language-only event never calls `processRows`, resolves accounts,
  invalidates page metadata or caches, or aborts/restarts queued requests. Mixed
  display/account changes still take the existing data-refresh path.
- A weak map keeps each mounted loading or resolved presentation (including
  empty/error-cleared results) independently of cache freshness or eviction.
  Locale callbacks reformat these presentations synchronously. In-flight and
  queued results read the latest locale when they render. The four-slot FIFO
  scheduler, mutation batching/attribute filtering, and row fingerprints remain
  unchanged; extension-owned localized nodes are excluded from row mutations.
- All reviewer state labels and completed-plus-still-requested combinations are
  full catalog messages. APPROVED, CHANGES_REQUESTED, COMMENTED, and DISMISSED
  retain the existing mapping: requested reviewers keep the blue ring; approved,
  changes-requested, or dismissed evidence adds the optional refresh badge.
  Requested COMMENTED has no refresh badge. Completed-only states retain their
  green/red/gray/purple ring and matching optional badge, sort order and links.
- All six access-banner kinds, CTAs, dismiss labels, usage clauses and reset
  cases are localized. Reset timing still uses ceiling minutes, then rounded
  hours; past resets say shortly. Existing retry claims are preserved. Locale
  changes read `aggregator.getState()` without reporting failures or resetting
  dismissal. Banner actions wrap on narrow screens.
- Translation uses text content and safe attributes. `lang` is set only on
  extension reviewer mounts and banners. GitHub HTML language, PR text, logins,
  team slugs, URLs, API enums and diagnostic evidence are unchanged.
- Regression coverage checks all five locales, nine reviewer-state combinations,
  all banner kinds and reset cases, dismissed/teardown behavior, no extra work
  for fresh/stale/missing/empty/error cache cases, loading/eventual locale,
  FIFO concurrency and observer stress. The isolated Chromium fixture switches
  the options preference while eight rows load, then checks seven completed rows
  and one error banner in all five locales at 360px with exact request counts.
