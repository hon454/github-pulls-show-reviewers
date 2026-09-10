# Contributing to GitHub Pulls Show Reviewers

Thanks for your interest in contributing. This repository is a
solo-maintained Chrome extension with a deliberately narrow product
scope. Please read [AGENTS.md](./AGENTS.md) for the authoritative
product rules and architecture expectations before proposing changes.

## Prerequisites

- Node.js 22.12+ (WXT 0.21 requires Node 22; Vite 8 requires 22.12+)
- `pnpm` 10.x (see the `packageManager` field in `package.json`)
- Playwright Chromium (optional — only needed for `pnpm test:e2e`)

## Getting started

Follow the [For Contributors section](./README.md#for-contributors) to
install dependencies and run the extension in development.

## Reporting bugs

Use GitHub Issues and pick the **Bug Report** template. Include
enough reproduction detail that the maintainer can act on the issue
without asking follow-up questions:

- Exact steps to reproduce
- Expected behavior and actual behavior
- Extension version and Chrome version
- Repository type (public or private)
- DOM / selector evidence when the issue is visual

Do not report security vulnerabilities through public GitHub Issues.
Use GitHub Private Vulnerability Reporting instead, as described in
[`SECURITY.md`](./SECURITY.md).

## Suggesting enhancements

Use GitHub Issues and pick the **Feature Request** template.
Enhancements must fit the product scope defined in `AGENTS.md`.
Proposals outside that scope will usually be declined unless the
maintainer explicitly agrees to widen scope first.

## Issue tracking

- GitHub Issues is the canonical tracker.
- Reference format is `#123`.
- All issues, PRs, and commits are written in English.

## Branch naming

Allowed prefixes for human-authored branches:

- `feat/`, `fix/`, `chore/`, `hotfix/`, `release/`

Agent worktree branches are named `claude/<slug>` (explicit
exception).

Rules:

- Lowercase letters, digits, and hyphens only.
- No spaces or underscores.
- No repeated, leading, or trailing hyphens.
- Dots only for release versions (e.g. `release/v1.2.0`).
- `chore/` is the default for docs-, style-, test-, build-, ops-only,
  and maintenance work.
- `hotfix/` branches still use `fix:` in commit subjects.

## Commit policy

See
[`docs/guidelines/commit-guideline.md`](./docs/guidelines/commit-guideline.md)
for the full rules. This repository has no pre-commit or commit-msg
hook gates; run the local checks listed in the guideline manually
before pushing.

## Pull request policy

See
[`docs/guidelines/pr-guideline.md`](./docs/guidelines/pr-guideline.md)
for title rules, the minimal and expanded description templates,
issue linkage, and the co-location checklist.
[`.github/pull_request_template.md`](./.github/pull_request_template.md)
auto-populates the minimal form when you open a PR.

## Issue linkage

Every PR states exactly one of:

- `Resolves #123` — closes the issue on merge
- `Part of #123` — partial progress, link only
- `No issue: <reason>` — intentionally untracked

Details and multi-issue forms are in the
[PR Guideline](./docs/guidelines/pr-guideline.md#issue-linkage).

## Co-location checklist

When a change affects behavior, selectors, permissions, storage,
auth, release artifacts, or Chrome Web Store copy, update the
companion doc in the same PR. The checklist lives in
the
[PR Guideline](./docs/guidelines/pr-guideline.md#co-location-checklist).

For the five README languages, same-PR translation updates, and the complete
change-to-document map, follow the
[Documentation Guideline](./docs/guidelines/documentation-guideline.md).

## Testing

For routine changes, `pnpm lint`, `pnpm typecheck`, and
`pnpm test` are the minimum expected signals. Before tagging a
release, run `pnpm verify:release`, which chains
`pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e`
as a single gate. PR CI runs the same four signals in parallel
jobs. Regenerate Chrome Web Store screenshots with
`pnpm cws:assets` only when store-facing visuals need to change,
and run `pnpm zip` (or `pnpm zip:release` for production
packaging) only after the checks above are green.

The scheduled [live GitHub DOM canary](./docs/live-github-dom-canary.md)
checks production GitHub markup separately. It is diagnostic and is not part
of the blocking pull-request gate; use its runbook for ownership, transient
failures, and captured evidence.

## Coding conventions

- Prettier and ESLint are authoritative for formatting and lint.
- TypeScript runs in strict mode.
- Follow the `Implementation Guidelines` section in
  [`AGENTS.md`](./AGENTS.md#implementation-guidelines) for patterns
  specific to this codebase.

## Dependency audits

The
[`dependency-audit`](./.github/workflows/dependency-audit.yml) workflow
runs `pnpm audit --audit-level moderate` on a weekly schedule (Mondays
09:00 UTC) and on demand via `workflow_dispatch`. The job fails when a
moderate-or-higher advisory appears, surfacing a notification to the
maintainer. There is no automated dependency PR bot; the workflow is
intentionally noise-light.

When the workflow fails:

1. Investigate the advisory locally with `pnpm audit`.
2. Bump the affected dependency or transitive override.
3. Run `pnpm verify:release` before pushing the fix.

As of 2026-09-10, both `pnpm audit --audit-level moderate` and
`pnpm audit --prod --audit-level moderate` report zero findings on the locked
graph. Vitest and its V8 coverage provider remain pinned to `4.1.11`, which
fixes [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).

WXT is pinned to `0.21.4`, with Vite `8.2.2` now an explicit development peer.
The [official WXT migration guide](https://wxt.dev/guide/resources/upgrading)
makes browser auto-launch optional. We omit `web-ext`, removing the old
`wxt > web-ext-run > firefox-profile > adm-zip@0.6.0` path and its obsolete
parent-scoped overrides. This removes the affected dependency from this project;
it does not fix `adm-zip` upstream. npm still lists `adm-zip@0.6.0` as latest,
and [GHSA-vwc7-r8mq-g2x9](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9)
still reports no patched version. Upstream
[PR #575](https://github.com/cthackers/adm-zip/pull/575) remains open.
`firefox-profile@4.7.1` still depends on `adm-zip ~0.6.x`, and
`web-ext@10.6.0` depends on that profile package, so installing the optional
runner would reintroduce the finding. Do not add it or an unpatched override
just to restore auto-launch. Recheck these upstream versions and both audits
before changing the development runner graph.

`pnpm dev` now requires manually loading `.output/chrome-mv3-dev` from
`chrome://extensions` with Developer mode enabled; keep the server running.
Production Chrome builds still use `.output/chrome-mv3`. The project keeps its
previous `noUncheckedIndexedAccess: false` setting explicitly while adopting the
other generated WXT TypeScript defaults, avoiding an unrelated repository-wide
indexed-access migration. `strict` and `exactOptionalPropertyTypes` remain enabled.
The audit workflow still checks the full graph and does not suppress advisories.

If a finding is a known false positive, document the rationale in the
fix commit instead of suppressing the workflow.

## Code of Conduct

This project follows the
[Contributor Covenant](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under
the repository's [MIT license](./LICENSE).

## Scope boundary

The `Product Rules` section in
[`AGENTS.md`](./AGENTS.md#product-rules) is authoritative. Any
change that expands scope beyond reviewer visibility needs prior
discussion with the maintainer before code is written.
