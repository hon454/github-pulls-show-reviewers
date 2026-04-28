# Chrome Web Store Screenshot Pipeline Design

## Context

The extension's store screenshots need to communicate the narrow product value:
requested reviewers and completed review state are visible directly on GitHub
pull request list pages. The first-priority audience is Chrome Web Store and
README visitors, not automated regression coverage.

The current asset flow already uses `pnpm cws:assets` to capture deterministic
screenshots from fixture HTML and mocked GitHub API responses. We want the
screenshots to feel closer to real GitHub while keeping reviewer states stable
enough to regenerate intentionally.

## Goals

- Show requested reviewers clearly in the PR list.
- Show completed review state clearly in the PR list.
- Keep the default screenshot UI centered on avatar-only reviewer chips with
  colored outlines and state badges, not reviewer-name pills.
- Add a before/after screenshot that explains the value without expanding the
  product into a broader PR dashboard.
- Keep screenshot regeneration deterministic and practical for maintainers.

## Non-goals

- Do not build a general PR dashboard or show unrelated PR metadata such as
  checks, mergeability, assignees, or labels.
- Do not depend on maintaining real reviewer accounts, real team review
  requests, or real completed review activity for every screenshot state.
- Do not make release CI mutate store screenshots automatically.

## Recommended Approach

Use a hybrid screenshot pipeline:

1. Capture a real GitHub pull request list page as the visual shell.
2. Capture a before image with the extension disabled or not loaded.
3. Capture an after image with the packaged extension loaded.
4. During the after capture, intercept the extension's GitHub API requests and
   return fixed reviewer summaries for the screenshot scenario.

This preserves the credibility of a real GitHub page while keeping reviewer
states deterministic. It avoids the operational cost of maintaining live dummy
PR review state across multiple GitHub users and teams.

## Screenshot Set

### 1. Before / After PR List

The first screenshot should be a split comparison of the same GitHub PR list:

- Before: GitHub's normal pull request list without inline reviewer chips.
- After: the same list with the extension rendering a `Reviewers:` strip.

The after side should use the default avatar-only rendering: 24px reviewer
avatars, blue requested-reviewer outlines, and completed-review badges.

### 2. Avatar State Showcase

The second screenshot should show a dense PR list with several rows. This
communicates that the extension works repeatedly across a list, not only on a
single hero row.

Recommended scenario:

- Row 1: requested user, approved reviewer, requested team.
- Row 2: requested user, changes-requested reviewer.
- Row 3: still-requested user with prior review evidence, commented reviewer.

The row titles can be realistic repository-maintenance PR titles, but they
should not introduce unrelated product scope.

### 3. Options Page

Keep the existing options-page screenshot pattern for display preferences and
repository diagnostics. It supports the store listing without competing with
the PR-list screenshots.

## Data Flow

The capture script should:

1. Build the packaged MV3 extension.
2. Open a persistent Chromium context without the extension and capture the
   before PR-list image from the target GitHub URL.
3. Open a separate persistent Chromium context with the packaged extension.
4. Route the GitHub API calls used by `fetchPullReviewerSummary` and return
   fixed pull and review payloads for each screenshot PR number.
5. Wait for `.ghpsr-root` to render expected reviewer chips.
6. Capture the after image and the state-showcase image.

The mocked API payloads remain screenshot fixtures, not production behavior.

## Error Handling

- If the live GitHub page cannot be reached, the capture command should fail
  with a clear message and leave existing assets untouched.
- If expected reviewer chips are not rendered, the command should fail before
  overwriting screenshot assets.
- If GitHub DOM changes break the capture, maintainers should update the
  screenshot fixtures or capture selectors deliberately.

## Testing

- Keep `pnpm cws:assets` as the manual store-asset generation command.
- Add focused Playwright assertions inside the capture spec before writing each
  screenshot:
  - the `Reviewers:` label appears on after screenshots;
  - requested reviewer avatars exist;
  - approved and changes-requested badge states exist;
  - before screenshots do not include `.ghpsr-root`.
- Do not add the screenshot capture to release CI unless store visuals become a
  release gate later.

## Open Implementation Detail

The live GitHub shell can come from either the production repository's PR list
or a small public demo repository. A demo repository gives tighter control over
PR titles and list length, but the reviewer state should still be supplied by
deterministic API interception rather than maintained as live GitHub review
state.
