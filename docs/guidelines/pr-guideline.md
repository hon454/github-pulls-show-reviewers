# Pull Request Guideline

This document covers PR titles, descriptions, issue linkage, and the
co-location checklist for this repository.

## Title

PR titles follow the same rules as the
[commit subject line](./commit-guideline.md#header):

- `<type>(<scope>): <subject>`
- Lowercase type and scope, imperative subject, no trailing period,
  ≤ 80 characters.
- One concern per PR.

For breaking changes, add `!`:

    feat(reviewers)!: drop dismissed-state chips

Breaking PRs also include a `Breaking Changes` section in the body.

## Minimal description template

Use this by default; the
[`.github/pull_request_template.md`](../../.github/pull_request_template.md)
auto-populates it.

    ## Summary

    One paragraph: what changed and why.

    ## Validation

    - pnpm lint: <pass | not run because ...>
    - pnpm typecheck: <pass | not run because ...>
    - pnpm test: <pass | not run because ...>
    - Manual: <what was verified in the browser or Chrome extension,
      or "not applicable">

    ## Related Issues

    Resolves #123
    (or) Part of #123
    (or) No issue: <reason>

## Expanded template (optional)

For large, risky, or multi-part changes, add these sections beneath
the minimal template:

    ## Context

    Prior state, constraints, and the problem being solved.

    ## Approach

    The chosen strategy and alternatives considered.

    ## Risk

    Known risk areas and mitigations.

    ## Rollout

    How the change is exercised after merge (manual testing, Chrome
    Web Store release, feature flag, etc.).

    ## Breaking Changes

    Required when the PR title carries `!`. Describe the break and
    the migration path.

## Issue linkage

Every PR states exactly one of these in its body:

- `Resolves #123` — closes the issue on merge (documented default).
  GitHub also recognizes `Closes #123` and `Fixes #123`; prefer
  `Resolves`.
- `Part of #123` — partial progress, link only, does not close. This
  is a textual link, not a magic word.
- `No issue: <reason>` — intentionally untracked. Give a one-line
  reason.

Multi-issue form: `Resolves #123, #124`.

For loose relationships to issues the PR does not close, comment on
the issue and link the PR rather than adding more magic words to the
PR body.

## Assignee

Maintainers and collaborators assign every PR to its author. When
using `gh pr create`, pass `--assignee @me`. When creating through
the web UI, set the assignee to yourself.

Outside contributors opening a PR from a fork generally cannot
assign PRs in this repository; the maintainer will set the assignee
on merge-track PRs. No action is required from the contributor.

## Co-location checklist

Before opening the PR, walk through these questions. When an item
applies, the same PR should carry the matching update.

1. Did reviewer UX behavior, copy, or the set of supported review
   states change? — update `README.md` "What The Extension Shows"
   and `docs/implementation-notes.md`.
2. Was `src/github/selectors.ts` touched? — add or update
   fixture-based regression coverage under `tests/`.
3. Did `wxt.config.ts` `permissions` or `host_permissions` change? —
   update `docs/privacy-policy.md` "What the extension accesses" and
   `docs/chrome-web-store-submission.md`.
4. Did the storage schema change (`src/storage/`, Zod records)? —
   update `docs/privacy-policy.md` "Storage and retention".
5. Did auth or device flow change? — update
   `docs/manual-chrome-testing.md` scenarios.
6. Was a new entrypoint or major module added or moved? — update the
   Repository Map in **both** `README.md` and `AGENTS.md`.
7. Was `package.json` `version` bumped? — add
   `docs/releases/vX.Y.Z.md`.
8. Was a new durable design decision made? — add or update
   `docs/adr/NNNN-<title>.md`.
9. Did release verification (`pnpm verify:release`) change? — update
   `README.md` "Pre-release Test Workflow".
10. Did Chrome Web Store user-facing copy or screenshots change? —
    update `docs/chrome-web-store.md`,
    `docs/chrome-web-store-submission.md`, and
    `docs/chrome-web-store-assets/`.

The minimal PR template includes an optional co-location note; use
it to confirm which items applied or record "none".
