# Live GitHub DOM Canary

The live GitHub DOM canary detects production markup drift that deterministic
fixtures cannot see. It loads the packaged MV3 extension in Chromium, opens an
all-state search of the public `cli/cli` pull request list in a clean browser
profile, and checks that:

- GitHub PR rows still match the centralized row selector.
- Every matched row exposes a pull number through the supported ID or link
  paths.
- The extension creates a reviewer mount for every discovered PR row.
- Requests to `api.github.com` carry no authorization header.

The canary does not inspect private data, configure an account, or add any
non-reviewer PR metadata.

## Scheduling and PR gate separation

`.github/workflows/live-github-dom-canary.yml` runs daily at 06:17 UTC and can
also be started with `workflow_dispatch`. The workflow has only `contents: read`
permission and does not receive a GitHub user token.

The live canary is intentionally absent from `.github/workflows/ci.yml` and from
the Playwright `default` project. Pull requests continue to block on the
deterministic fixture-backed suite run by `pnpm test:e2e:run`; GitHub uptime,
rate limiting, and live markup delivery therefore cannot make ordinary PR
development flaky.

## Ownership and transient failures

The repository maintainer owns first triage of scheduled canary failures. The
Playwright live project retries twice within one run to absorb brief navigation
or GitHub availability failures. A failed run remains failed; the workflow does
not use `continue-on-error`.

Before changing selectors, check
[GitHub Status](https://www.githubstatus.com/) and manually rerun the failed
workflow once. Treat a passing rerun during a documented GitHub incident as
transient. Repeated failures, or a failure whose saved DOM no longer contains
the expected selector structure, require investigation.

## Failure evidence and investigation

Failed runs upload the Playwright `test-results` directory for 14 days. It
contains the retained trace and failure screenshot plus:

- `canary-diagnostics.json`: target/current URL, HTTP status, row/pull/mount
  counts, and whether any API request unexpectedly carried authorization.
- `github-pr-list.html`: the delivered GitHub page DOM at failure time.

Investigate a recurring failure in this order:

1. Download the `live-github-dom-canary-*` artifact and inspect
   `canary-diagnostics.json` for redirects, non-200 responses, or count
   mismatches.
2. Open the trace and screenshot to distinguish a GitHub availability or abuse
   challenge from actual PR-list markup drift.
3. Compare `github-pr-list.html` with `src/github/selectors.ts` and the existing
   fixtures under `tests/fixtures/`.
4. If markup drift is confirmed, update the centralized selector with a clear
   fallback and add the captured structure as a minimized deterministic fixture
   regression before changing the canary.
5. Run `pnpm test:e2e` locally. The live check can be reproduced separately
   after `pnpm test:e2e:build` with `pnpm test:e2e:live`.

Do not add retries indefinitely or weaken row/pull/mount assertions to hide a
recurring failure. If GitHub permanently restricts unauthenticated automation,
open an issue with the saved evidence before changing the no-token policy.
