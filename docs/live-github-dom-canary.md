# Live GitHub DOM Canary

The live GitHub DOM canary detects production markup and reviewer-result drift
that deterministic fixtures cannot see. It loads the packaged MV3 extension in
a clean, English-language Chromium profile and opens an all-state search of the
public `cli/cli` pull request list. The profile has no GitHub account, extension
account, or token.

The canary is an outcome check, not a mount smoke test. It verifies all of the
following before it passes:

- An independent oracle finds exact `/<owner>/<repo>/pull/<number>` links in
  the page's `main` pull-list rows, deduplicates their pull numbers, and confirms
  that the production row selector covers the same set. PR links outside
  `main`, links in sidebars or prose without an `issue_<number>` row, and deeper
  paths such as `/files` are not part of the denominator.
- Every independently found row has exactly one extension mount and no mount is
  left in its loading state. Every element with a reviewer chip class remains
  in the actual snapshot; a malformed qualifier or foreign search link is an
  invalid chip, never silently reclassified as empty.
- Each row is classified as rendered, verified empty, extension failure, or
  unverifiable. An empty mount is accepted only when complete observed API
  evidence independently predicts no reviewer chips.
- The observer reads only responses to public API requests already made by the
  extension. It never sends an oracle request. It waits for all bounded
  asynchronous body reads before evaluating the page and retains only pull
  numbers, public reviewer/team identifiers, review/request states, comparison
  timestamps, endpoint status, and rate-limit quota.
- At most three pull requests with complete evidence are compared in detail.
  The sample must contain at least one actual reviewer chip and includes a
  verified empty result when one is available. Pull numbers, reviewers, and
  review counts come from the live responses; none are fixed in the test.
- Reviewer identifiers, requested/completed state, reviewer-search qualifier,
  ring treatment, and badge are compared with a small test-only oracle. The
  oracle does not import the production summary or view-model mapper.
- No request to `api.github.com` carries an Authorization header.

## Independent reviewer policy

The oracle excludes reviews by the PR author and prefers the latest recognized
non-comment review over a `COMMENTED` review for the same user. It handles
`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, and `DISMISSED` explicitly.

For a user who is both in current requested-reviewer metadata and has a
non-comment review, requested state is removed only when the observed request
event history is complete, both comparison timestamps are valid, and the
latest request is not later than the latest non-comment review. A directly
observed later request is confirmed even when history is truncated or
unavailable. Partial, unavailable, missing-event, or date-incomparable evidence
otherwise keeps the reviewer requested but unverified; the requested search
link remains and the refresh badge must be absent. Legacy or missing evidence
is never promoted to confirmed.

This policy mirrors the public evidence contract without sharing production
mapping code. Its fixed complete, truncated, unavailable, author,
non-comment-priority, and timestamp cases run in ordinary Vitest.

## Failure and unverifiable outcomes

The canary fails rather than skips, continues on error, or falls back to
mount-only success. Diagnostics assign each reason to one of three owners:

- `extension`: missing/duplicate production rows or mounts, loading that does
  not settle, an invalid reviewer chip, an active reviewer-failure banner,
  unexpected Authorization, a missing extension API request, or a rendered
  reviewer mismatch.
- `environment`: a GitHub challenge, missing live list rows, HTTP 429 or 5xx,
  or the absence of any complete reviewer-bearing sample in the current public
  data.
- `observation`: an API failure, response body timeout/read/schema failure,
  missing metadata/reviews evidence, truncated or unavailable reviews, or a
  body still pending at assertion time.

A list or metadata response with HTTP 200 is insufficient when the matching
reviews response fails. Page replacement or navigation that leaves the current
host rows without matching response evidence is also unverifiable, not empty.

## Deterministic coverage and PR gate separation

`tests/live-github-canary.test.ts` covers the independent oracle and failure
matrix without a browser. `tests/e2e/live-github-canary-fixture.spec.ts` runs
positive rendered/empty, negative detail-failure, and native-link
pagination/back/forward/filter navigation scenarios in the packaged extension
suite. The surrounding controller fixture also holds eight FIFO rows across a
same-repository navigation and proves that late results cannot render or
populate the former generation's cache.

The live test uses one finite, clean-profile sequence on the same public
repository:

1. A opens the all-state pull list.
2. B reads and clicks GitHub's actual same-repository pagination link.
3. C uses browser Back to return to A.
4. D reads and clicks an actual same-repository Open or Closed filter link.

The test does not synthesize `history.pushState` or extension events. It reads
the native locator and href before each click, verifies the current PR-number
set after B and D changes, and records whether each transition preserved the
document. Full document navigation is evidence of full navigation, not a
claimed PJAX success; the deterministic fixture owns same-document race
coverage. A missing pagination/filter link, changed PR set, challenge, rate
limit, or insufficient sample fails the required sequence rather than skipping
it.

A host-confirmed empty list is valid only when its independent list container
is present and it has zero rows and zero mounts. A missing list container with
zero discovered rows remains a selector/host failure, not an empty result.

`.github/workflows/live-github-dom-canary.yml` runs the live project daily at
06:17 UTC and can also be started with `workflow_dispatch`. The workflow has
only `contents: read` permission, does not persist checkout credentials, and
does not receive a GitHub user token. The Playwright live project retries at
most twice within one run.

The live test remains absent from `.github/workflows/ci.yml` and from the
Playwright `default` project. Pull requests block on deterministic Vitest and
packaged fixtures; GitHub uptime, rate limiting, challenge delivery, and live
data changes therefore cannot make ordinary PR development flaky.

Run the focused deterministic checks with:

```bash
pnpm exec vitest run tests/live-github-canary.test.ts tests/playwright-config.test.ts tests/ci-workflow.test.ts
pnpm test:e2e
```

After building the TESTING GitHub App package, run the separate public canary
with:

```bash
pnpm test:e2e:build
pnpm test:e2e:live
```

## Evidence

`canary-diagnostics.json` is attached on both success and failure. Each live
navigation stage additionally persists and attaches
`canary-navigation-A.json` through `canary-navigation-D.json`, so a failing
stage does not overwrite the previous successful evidence. Every navigation
record includes its stage/operation, previous and current public URLs,
document-maintained observation, host PR-number set, mount/loading/terminal
counts, bounded expected/actual samples, and observed endpoint quota. The test
reads each persisted JSON back before accepting its stage. The diagnostics
contain
only the observation phase, target/current public URL and navigation status,
independent/production row counts, active failure-banner and
mount/loading/rendered/invalid-chip/terminal counts, up to three minimal
expected/actual samples, endpoint kind/status/body outcome and quota, API
request counts, and structured failure codes. It never contains banner copy,
raw response bodies, full response headers, Authorization values,
credentials, or private repository data.

Failed scheduled runs upload the Playwright `test-results` directory for 14
days. The retained trace and failure screenshot are accompanied by:

- `canary-diagnostics.json`, for the minimal stage/count/sample/endpoint
  comparison described above.
- `github-pr-list.html`, for the delivered GitHub page DOM when the assertion
  failed.

Artifacts are collected only from the clean public profile.

## Triage

The repository maintainer owns first triage of a scheduled failure. Inspect one
run in this order:

1. Read `canary-diagnostics.json`. Start with the failure owner and phase, then
   compare independent/production row counts, terminal counts, endpoint
   statuses, body outcomes, quota, and the bounded reviewer samples.
2. For an environment-owned failure, inspect the trace and screenshot for a
   GitHub incident, challenge, rate limit, or public data set with no complete
   reviewer sample. Do not relabel it as a passing mount check.
3. For an observation-owned failure, use endpoint/body completeness to decide
   whether GitHub delivery, pagination, response parsing, or a navigation
   mismatch prevented verification.
4. For an extension-owned mismatch, compare the minimal expected/actual sample
   and saved DOM with `src/github/selectors.ts`, reviewer DOM semantics, and the
   deterministic fixtures.
5. If selector drift is demonstrated, minimize the captured structure into a
   fixture before changing the centralized production selector. Do not change
   selectors based only on an assumed live markup change.

The bounded Playwright retries are the only automatic retries. Do not add
unbounded retries, `skip`, `continue-on-error`, a mount-only fallback, an oracle
HTTP request, or authenticated/private data to make a recurring failure green.
If GitHub permanently restricts unauthenticated automation or the live data can
no longer provide the required reviewer-bearing sample, preserve the evidence
and resolve the support-policy decision explicitly before weakening the check.
