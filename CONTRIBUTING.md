# Contributing to GitHub Pulls Show Reviewers

Thanks for your interest in contributing. This repository is a
solo-maintained Chrome extension with a deliberately narrow product
scope. Please read [AGENTS.md](./AGENTS.md) for the authoritative
product rules and architecture expectations before proposing changes.

## Prerequisites

- Node.js LTS
- `pnpm` 10.x (see the `packageManager` field in `package.json`)
- Playwright Chromium (optional — only needed for `pnpm test:e2e`)

## Getting started

Follow the `Quick Start` section in [`README.md`](./README.md) to
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
companion doc in the same PR. The full 10-item checklist lives in
the
[PR Guideline](./docs/guidelines/pr-guideline.md#co-location-checklist).

## Testing

See the `Pre-release Test Workflow` section in
[`README.md`](./README.md) and run `pnpm verify:release` before
tagging a release. For routine changes, `pnpm lint`,
`pnpm typecheck`, and `pnpm test` are the minimum expected signals.

## Coding conventions

- Prettier and ESLint are authoritative for formatting and lint.
- TypeScript runs in strict mode.
- Follow the `Implementation Guidelines` section in
  [`AGENTS.md`](./AGENTS.md#implementation-guidelines) for patterns
  specific to this codebase.

## Code of Conduct

This project follows the
[Contributor Covenant](./CODE_OF_CONDUCT.md).

## Scope boundary

The `Product Rules` section in
[`AGENTS.md`](./AGENTS.md#product-rules) is authoritative. Any
change that expands scope beyond reviewer visibility needs prior
discussion with the maintainer before code is written.
