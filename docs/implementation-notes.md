# Implementation Notes

## Current MVP behavior

- Background stores multiple connected accounts in v4 local storage: a versioned
  `settings` ID registry and separate profile/auth/installation fragments. UI
  receives only allowlisted summaries and safe preferences. Each account caches
  its GitHub App installations. `all` installations cover the owner directly;
  `selected` installations carry an explicit repository snapshot with both
  full names and a `complete` / `truncated` completeness marker.
- Options schedules device-flow polling ticks using opaque IDs. Background owns
  OAuth HTTP, user/installation discovery and commits. Trusted session records
  restore waiting flows across worker suspension; interrupted exchanges offer
  a new code. Cancellation is acknowledged only before commit admission.
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

- `src/background/ui-bridge.ts` validates sender/context capabilities;
  `ui-state.ts` owns raw storage events and safe snapshots. `storage-policy.ts`
  gates access and initialization, `account-summary.ts` projects safe accounts,
  and `device-flow.ts` owns sign-in state/HTTP/restoration/commit admission.
- `src/runtime/ui-contract.ts` and `ui-client.ts` provide strict UI messages and
  shared revision-aware subscriptions. Account/preferences/diagnostics wrappers
  expose capabilities without credentials; `src/shared/preferences.ts` is pure.
- Background `account-resolution.ts` preserves bounded self-healing and current
  fallback selection. The content module delegates using its repository context.

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
   suppressed and the existing page banner receives that failure once. The
   suppressed attempt completes and releases its row request ownership. Later
   GitHub-owned row metadata changes, navigation, or account invalidation can
   reprocess it and retry; reaching a rate-limit reset time alone does not
   trigger a retry.
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
9. Publish typed page/account-generation and PR/request outcomes to the banner
   integration; do not render
   row-level error text. Network, schema, and unknown failures use the generic
   reviewer-unavailable state with a same-page reload link. Repeated failures
   are deduplicated by the aggregator. Every visible row is registered as pending
   before processing, including queued requests. Fresh cache hits and successful
   empty reviewer summaries settle successfully; stale chips alone do not.
   A shared metadata failure has one identity but settles every suppressed row.
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

An unchanged fingerprint does not by itself prove that the extension mount
survived. The lifecycle separately remembers rows that previously had a mount.
When equivalent native metadata replaces that mount, it reprocesses the row
without making the reviewer or page-metadata caches stale. A fresh summary
therefore remounts from cache without another runtime request; a stale summary
uses the existing bounded revalidation path.

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
- Chrome metadata, options/auth, repository diagnostics, content reviewer labels,
  and access banners use the five bundled catalogs. No runtime translation
  service is used.

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
- Every row attempt releases in-flight ownership on settlement, including
  account/fallback resolution rejection, suppressed metadata failure, and
  cancellation. Cleanup checks request identity so an older completion cannot
  remove a replacement request after invalidation. The shared metadata failure
  cache still suppresses per-row fallback until eligible reprocessing; display
  and locale changes only rerender and do not invalidate failures or retry
  requests, even after metadata cache freshness expires.
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

- Each no-token public request remains the first attempt when no covering
  account exists. An eligible anonymous-to-account retry remains inside its
  existing summary slot. Repository discovery is shared outside the row queue,
  so waiting rows cannot deadlock by reserving all four slots for a new probe.
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

| Account state | Failure pattern                                      | Banner kind             | CTA                             |
| ------------- | ---------------------------------------------------- | ----------------------- | ------------------------------- |
| Signed in     | 401 on any reviewer endpoint                         | `auth-expired`          | Sign in                         |
| Signed in     | Final 404 / 403 without a rate-limit signal          | `app-uncovered`         | Configure access                |
| Signed in     | 429, or 403 with `x-ratelimit-remaining: 0`          | `auth-rate-limit`       | (no button; reload after reset) |
| No account    | 429, or 403 with rate-limit signal                   | `unauth-rate-limit`     | Sign in                         |
| No account    | 401, 403, or 404 without rate-limit signal           | `signin-required`       | Sign in                         |
| Either        | Network / schema / unknown / empty endpoint envelope | `reviewers-unavailable` | Reload page                     |

Severity priority for cross-row resolution: `auth-expired` > `app-uncovered` >
`auth-rate-limit` > `unauth-rate-limit` > `signin-required` >
`reviewers-unavailable`. Guidance reflects current outcomes for the visible PRs
in the active page/account generation. Route or account invalidation registers
the new visible set as pending before any work can complete. While any work is
pending (including the fifth and later FIFO-queued rows), the previously
published guidance may remain; a new higher-priority failure can still appear.
Once all relevant work settles, the highest-priority remaining failure wins, so
recovery can downgrade guidance or clear it entirely. One successful row cannot
hide another row's failure or pending request.

A partial row retry replaces only that PR's outcome and retains other visible
results. Removing rows removes their outcomes; an empty list clears guidance
from removed rows. Duplicate DOM rows share the PR/request identity. Mount-only
restoration preserves data outcomes rather than treating DOM rendering as a
successful retry. Stale/cold mounts still use the existing bounded revalidation
or in-flight join; a real new attempt replaces only its PR's outcome with pending.
Old generations and superseded request identities cannot
publish results into the current aggregate. Membership and synchronous row work
are published together, avoiding a transient recovery during a mutation batch.

Banner dismissal is keyed by `pathname + kind`, so dismissing one kind on a page
does not suppress a later, higher-priority kind on the same page.

For rate-limit kinds (`auth-rate-limit`, `unauth-rate-limit`), the GitHub
response's `x-ratelimit-limit / -remaining / -reset / -resource` headers ride
with the failure envelope (`ReviewerFetchFailure.rateLimit`) into the
aggregator, so the banner can report `(used/limit)` and a relative reset
time. Callers fall back segment-by-segment: missing limit/remaining omits the
usage clause, and a missing reset timestamp keeps the static reset copy. The
snapshot is in-memory only — it is never persisted.
Quota-reset copy describes when the limit resets and instructs the user to
reload the page afterward. A missing timestamp uses localized unknown-time
guidance. Reprocessing on an account change, meaningful GitHub row mutation, or
navigation can also retry; no timer, polling or quota-reset-triggered retry is
scheduled. Locale and display preference changes only reformat presentation,
without changing generations, outcomes, caches, dismissal or request order.

## Credential generation and background account commits

- Each auth record stores an opaque `credentialGeneration`. A sign-in or token
  rotation creates a new UUID. The background owner migrates legacy v2/v3
  accounts and missing v4 revisions before admitting account work. Missing
  revisions in old read snapshots use a stable non-secret `legacy` identity,
  which migration persists unchanged because it does not rotate credentials;
  ordinary queries do not write migrations or repair the account registry.
  Missing v4 revisions update only auth metadata. That exact migration event
  does not cancel/refetch reviewer work; credential changes and registry repair
  still invalidate the page's account-dependent data.
- `accountMutations` in `src/storage/accounts.ts` is the background-only owner.
  Its short commit queue rereads the registry before normalized-login upsert,
  duplicate consolidation, removal, initialization/repair and conditional auth
  writes. All registry and fragment writes share that queue. Background device
  flow commits through that owner, and `src/runtime/account-mutations.ts` exposes
  options-only local removal. Future account work must reuse this owner.
- The options account card keeps local removal available whether credentials are
  active or invalidated. It calls the same background mutation wrapper by
  account ID, so removal neither starts device sign-in nor revokes the GitHub
  App; while it is pending, every action on that one card is disabled.
- Reviewer summaries and metadata batches, installation refresh, options
  diagnostics and background retry helpers identify the credential
  actually used. On 401, the coordinator reuses a newer valid generation or
  joins its active refresh; it rotates only a still-current failed generation.
  One API retry is allowed. A rejected retry invalidates only its own generation
  while it is still current. Refresh completion and terminal refresh failure
  cannot be overtaken by retry invalidation for the same generation. The
  coordinator records admission before its first storage await: invalidation
  waits for earlier same-generation recovery, while later recovery waits for
  that invalidation before rereading state. Only earlier admissions are wait
  dependencies, preventing cycles. All waits remain outside the registry queue;
  a different generation's HTTP remains independent.
  A successful rotation survives; a terminal failure retains `refresh_failed`.
  If refresh is transient, a genuinely rejected still-current retry may retain
  the existing `revoked` outcome. Refresh completion and terminal failure
  use the same conditional commit, so old work cannot overwrite a newer sign-in
  or revive a removed account. The raw refresh/invalidation runtime endpoints
  are removed. UI requests operations; background retry helpers reread current
  accounts and stop if an account is gone or invalid.
- HTTP never holds the registry commit queue, preserving network concurrency
  across accounts. Installation snapshots commit conditionally against their
  request generation. The manual options refresh uses the background
  installation service. The 15-minute alarm rechecks current expiry and the
  30-minute threshold inside the coordinator, including expiry invalidation.
- Local/session storage is restricted to trusted contexts before initialization
  or sensitive operations. Content access is browser-blocked; options is still
  trusted by Chrome, so its token-free guarantee is enforced by application
  boundaries. Worker lifetime and persistence after server rotation but before
  the durable credential write remain unguaranteed. See ADR 0008.
- Deferred regression coverage uses real service/coordinator/storage/HTTP
  parsing boundaries: A and B start with g0; A rotates to g1 and starts its retry;
  only then does B's g0 response fail. Both succeed on g1 with one refresh.
  Additional barriers cover obsolete retries, sign-in/removal, alarm expiry,
  registry add/add, same-login creation, add/remove, repair/add, migration/add,
  and independent HTTP while another account is stalled.

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
- `createSelfHealingAccountResolver` (`src/background/account-resolution.ts`)
  wraps resolution: a complete cached selected-installation miss checks stored
  same-owner candidates, requests the background installation service and reruns
  resolution. The content facade receives an `AccountSummary`, never a full
  account. Repository context and installation owner restrict content refresh.
- The background-side `createInstallationRefreshService` (`src/background/installation-refresh.ts`) holds the token, refreshes via `RefreshCoordinator` on 401, persists through `replaceInstallations`, and dedupes concurrent calls per `accountId`. The service response does not include tokens; content has no direct local-storage access.
- Each candidate is refreshed at most once per page session. Successful
  installation writes change the sanitized account/coverage digest; the content
  snapshot subscriber clears the row cache and rerenders covered rows.
- Genuinely uncovered repos still flow into the `app-uncovered` /
  `signin-required` banner copy after the refresh attempt completes. When a
  connected fallback account is available, uncovered private repositories are
  reported through the signed-in `app-uncovered` path rather than the no-account
  sign-in path.
- Options diagnostics uses the same repository discovery policy below and
  includes an incomplete selected-installation snapshot warning alongside the
  account actually used.

## Bounded repository account discovery

- [ADR 0009](./adr/0009-bounded-repository-account-discovery.md) records policy
  1A. `repository-accounts.ts` owns discovery in background; content receives an
  opaque document-bound ticket plus sanitized actual-account results. The
  existing initial account resolver and bounded installation self-heal remain
  intact. An `all` installation describes App coverage, not each user's access.
- Only an authenticated, non-rate-limited repository 403/404 opens the serial
  candidate chain. Candidates must still exist, be active and have same-owner
  installation evidence (case-insensitive). `all` and explicitly selected
  repository coverage precede truncated selected snapshots; each tier preserves
  `listAccounts()` order, deduplicated by account ID. Complete selected misses
  become eligible only when existing bounded self-heal supplies new evidence.
  No unrelated-account probe or upfront full repository enumeration is added.
- The entire unresolved endpoint envelope is retained and classified. Any 429,
  primary exhausted quota, secondary-rate-limit signal or unresolved 401 stops
  discovery; so do network, schema, 5xx, cancellation and unknown failures.
  Mixed 404+429/401 cannot advance. The existing generation-aware refresh owner
  may retry a 401 with that same account only. Internal rotation consumes no new
  candidate identity and does not reopen a page discovery generation.
- A successful pull-list metadata probe proves repository access, even when it
  returns an empty list. An individual PR/reviews 404 remains a row failure;
  another PR can render through the same successful account. Diagnostics reports
  that distinction and identifies the account actually used, including fallback
  B rather than initially selected A. Its no-token action stays anonymous, and
  an explicit diagnostic run has a separate cancellable generation.
- The background trusted-session ledger records each distinct account admission
  **before HTTP**, including the initial account. A generation cannot admit an
  account twice. The bound is the number of distinct eligible accounts, not the
  number of rows. Metadata/summary results and page caches carry the actual
  resolved account ID and opaque revision. Success and negatives are scoped to
  the document, repository and explicit generation, never an owner-wide or
  permanent account association.
- Joined callers own separate cancellation subscriptions. Either caller may
  cancel first without aborting the other; the last consumer or explicit
  generation invalidation aborts shared work. Reservations remain consumed.
  Worker restoration can resume a confirmed denial with an unattempted eligible
  account; stop/exhaustion remain terminal, and admitted unresolved work becomes
  interrupted until an explicit new generation. A missing/retired record cannot
  reset the budget. Superseded bodies are deleted while the live document keeps
  a small high-water mark; detected document loss removes both. Chrome's
  `getContexts` omits content documents, so content liveness uses the recorded
  tab and a document-targeted content probe. Frozen/unresponsive documents keep
  their budgets. Ordinary port disconnection is not owner loss.
- Reload/navigation, force refresh, removal/reconnection or changed installation
  coverage may create a new discovery generation. Credential invalidation alone
  cancels obsolete row work but retains terminal 401 evidence. Duplicate row
  mutations, cache TTL, mount repair, language and display changes cannot retry
  failed candidates. A successful account may receive an ordinary metadata
  refresh without resetting admissions; a later proven repository denial can
  continue only to unattempted candidates. There are no automatic retry timers.
- Public anonymous success and the previous single unambiguous account fallback
  after anonymous access/rate-limit failure remain separate from this policy.
  An authenticated quota failure always stops the new chain. The four-slot FIFO,
  settled cleanup, stale chips and generation-scoped aggregate banner consume
  final row outcomes; an intermediate recovered A denial is never published.

The deterministic production-service, ledger/bridge and actual DOM regressions
live in `tests/repository-accounts.test.ts`,
`tests/repository-discovery-bridge.test.ts` and
`tests/repository-fallback-dom.test.ts`. The packaged fixture
`multi-account repository fallback` uses synthetic accounts and mocked HTTP;
it is not a live private-repository permission check.

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

## Device flow and UI boundary

- `src/background/device-flow.ts` owns initiation, polling HTTP, user and
  installation discovery, and commit admission. Options creates an attempt ID
  before initiation and schedules ticks with its returned opaque flow ID.
  UI receives only user codes, verified links, interval/deadline and stable
  progress/error codes. The OAuth device code and access/refresh tokens stay
  in background. The existing Device Flow grant and permission scope are unchanged.
- One ordered flow owner admits cancel and commit. A persisted cancellation ACK
  prevents later commit for that attempt. Already admitted writes return
  `committing`/`connected`; the UI waits for the outcome, without rollback or
  deleting an account. Completion returns the actual ID chosen by the existing
  normalized-login registry owner. Late results cannot advance a newer panel.
- Trusted session records restore waiting flows with their original ID, deadline,
  slowdown interval and next allowed poll. Concurrent polls share a request and
  background enforces the interval. On `slow_down`, add at least five seconds.
  Interrupted HTTP returns `restart_required`; interrupted commits reconcile
  the account's atomic opaque `connectionAttemptId` receipt before returning.
- Cancel, expiry, completion and detected owner loss clear secret flow fields.
  Worker activation and flow entrypoints expire abandoned entries; there is no
  background polling loop, keepalive or new alarm. A browser restart clears
  pending session state and offers a new code without removing connected accounts.
- Sender authorization requires the same extension ID, browser document ID and
  recognized options/content URL. Flows belong to their options document.
  Content cannot invoke login/removal/diagnostics/preference writes; its
  repository-bound resolution/refresh capabilities preserve existing self-healing.
- Background alone receives raw storage changes. Both UIs share a validated
  snapshot/port client with worker epoch and monotonic revision. Stale initial
  reads, delayed RPC results and callbacks from disconnected workers are ignored.
  Teardown releases subscriptions; reconnect hydrates fresh state without pings.
  The reviewer page starts row work on its first valid read or subscription
  snapshot, including recovery after an initial read failure. A late initial
  read cannot replace preferences already delivered by the subscription.
- Preference writes use strict partial patches and one short background
  read/merge/write queue across options documents. Only successful commits emit
  changed snapshots. Different-field updates preserve both values; same-field
  updates follow admitted order. Failed writes leave the queue usable.
- Account/coverage digest changes invalidate data decisions. Language and
  `showStateBadge`, `showReviewerName`, `openPullsOnly` rerender existing UI only;
  reviewer caches, outcomes, four-slot FIFO order and request counts stay intact.
- Full rationale, restoration cases, trusted-context limitations and contracts
  for #176/#171: [ADR 0008](./adr/0008-background-credentials-and-ui-capabilities.md).

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
store subscribes to the shared safe UI snapshot client while active, safely
orders hydration against events/writes, and exposes React/DOM disposal adapters.
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
- User verification codes, URLs, account identifiers, product/App names and
  `Pull requests: Read` remain literal. Expiry is formatted with the selected
  BCP 47 locale and the user's existing timezone; UTC instants are not changed.
- Display saves and account refresh/remove/load status keep keys/actions, not
  translated sentences. Changing language reformats visible status without
  repeating work. Preference patches from all options documents are serialized
  in background against the latest saved record.
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
  subscribes once; the store uses the shared safe UI snapshot client. Reviewer
  subscriptions stop outside PR-list routes and on context invalidation; banner
  teardown releases its subscription on route changes and invalidation.
- `page-controller.ts` applies display and language changes only to existing
  presentations. Neither calls `processRows`, resolves accounts, invalidates
  page metadata or caches, or aborts/restarts queued requests. Events that also
  change accounts still take the existing data-refresh path.
- A weak map keeps each mounted loading or resolved presentation (including
  empty/error-cleared results) independently of cache freshness or eviction.
  Resolved presentations retain their source summary and route, so display
  changes can rebuild names, badges and reviewer links without reading or
  revalidating the cache. Locale callbacks reformat presentations synchronously.
  In-flight and queued results use the latest display preferences and locale
  when they render; late preference reads cannot overwrite a newer display
  event.
  Async presentation checks the current page/account generation, mount operation
  and latest request identity after preference reads and before continuing data
  work. Removed or superseded rows cannot render late results or start queued
  requests; a live replacement row can still receive its shared request.
  Request/cache validity follows the PR row and generation, not its presentation
  mount. Replacing only native metadata preserves valid pending results for
  cache-based mount recovery; detached mounts still cannot render those results.
  The four-slot FIFO scheduler, mutation batching/attribute filtering, and row
  fingerprints remain unchanged; extension-owned localized nodes are excluded
  from row mutations.
- All reviewer state labels and completed-plus-still-requested combinations are
  full catalog messages. APPROVED, CHANGES_REQUESTED, COMMENTED, and DISMISSED
  retain the existing mapping: requested reviewers keep the blue ring; approved,
  changes-requested, or dismissed evidence adds the optional refresh badge.
  Requested COMMENTED has no refresh badge. Completed-only states retain their
  green/red/gray/purple ring and matching optional badge, sort order and links.
- All six access-banner kinds, CTAs, dismiss labels, usage clauses and reset
  cases are localized. Reset timing still uses ceiling minutes, then rounded
  hours; past resets say shortly. Authenticated rate-limit copy in every timing
  variant describes the quota reset followed by a user-initiated page reload,
  including the unknown-time fallback; it does not promise automatic resumption. Locale
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

## Integrated locale quality (#151)

All 172 messages in each of the five shipped catalogs have a recorded linguistic
review and glossary in [localization.md](localization.md). Labels clarify that
reviewer names are GitHub usernames and the open-PR setting filters link
destinations. Runtime, permissions, data contracts and review semantics are
unchanged. Strict source/package validation rejects malformed or untranslated
shipped entries; packaged QA covers account/diagnostic failures, live device-flow
switches, native API/metadata observations, reload and process-restart persistence.
The native probe runs in a standalone Node subprocess to avoid Playwright
Test's default locale injection. Actual Korean Auto/metadata selection and
remaining manual platform checks are recorded, not inferred from launch flags.

## Localized store artifacts

The five descriptions under `docs/chrome-web-store-locales/` reference catalog
metadata directly. `pnpm cws:assets` uses persisted locale selection, synthetic
GitHub/API/avatar fixtures and TESTING GitHub App configuration to generate three
RGB 1280x800 scenes per locale. English remains in the asset root, preserving
landing references; four regional directories hold the other images. The options
scene composes actual language/display/diagnostic sections, and PR fixture spacing
keeps all eight rows visible without translating host content. Screenshot text is
read from the final catalogs and reviewed composition comments.

`pnpm verify:cws` verifies metadata identity/limits, listing and image links/order,
PNG format, and recorded capture source/image hashes. The capture manifest records
browser/platform/system-font assumptions; identical pixels require the same render
environment. Per-image visual review and dashboard registration are separate
steps in the [submission packet](./chrome-web-store-submission.md#capture-maintenance).
These artifacts are not production-config package or publication evidence.
