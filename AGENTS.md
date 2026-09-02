# AGENTS.md

## Purpose

This repository builds a Chrome extension that improves one workflow: show reviewer information directly inside GitHub pull request list pages.

Agents working in this repository should preserve that narrow product scope. Do not expand the product into a general PR dashboard unless the user explicitly asks for it.

## Product Rules

- Optimize for reviewer visibility first.
- Keep the initial UX centered on requested reviewers, requested teams, and completed review state.
- Treat unrelated PR metadata such as checks, mergeability, assignees, or labels as out of scope unless the user approves a scope change.
- Prefer public-repository support without a token when possible.
- For private repositories, guide users to sign in with GitHub through the maintainer-owned GitHub App (OAuth Device Flow). Multi-account storage is supported and the App requests `Pull requests: Read` only.

## Technical Baseline

- Framework: `WXT`
- Language: `TypeScript`
- Options UI: `React`
- Runtime target: Manifest V3 Chrome extension
- Validation: `zod`
- Tests: `Vitest` and `Playwright`
- Package manager: `pnpm`

## Repository Map

- `entrypoints/content.ts`
  Content script entrypoint for GitHub pull list pages.
- `entrypoints/background.ts`
  Background lifecycle hooks such as install behavior.
- `entrypoints/options/`
  Options page UI and bootstrapping.
- `src/github/`
  GitHub-specific routing, selectors, and API access. `api.ts` is the stable
  facade; `api/` separates schemas and parsing, authenticated request and
  pagination helpers, reviewer aggregation, diagnostics, and shared types.
- `src/features/reviewers/`
  Reviewer-focused feature orchestration and rendering. `index.ts` is the
  stable facade; the page controller delegates page metadata caching, fallback
  account integration, runtime requests, and row mutation handling to focused
  modules.
- `src/storage/`
  Extension settings and persistence.
- `src/cache/`
  Request and page-session caching helpers.
- `tests/`
  Automated tests, including future extension regression coverage.

## Implementation Guidelines

- Separate DOM access from GitHub API access.
- Keep GitHub selectors centralized in `src/github/selectors.ts`.
- Prefer typed parsing and narrow data contracts over ad hoc object access.
- Avoid row-level duplicate fetches. Reuse cache entries when possible.
- Treat GitHub DOM as unstable. New selectors should have a clear fallback strategy.
- Keep the content script light. Move reusable logic into `src/`.
- Use `browser.storage.local` for extension settings unless there is a clear reason not to.
- Keep reviewer rendering deterministic and testable through pure view-model helpers where possible.
- Update `README.md` and `docs/implementation-notes.md` when MVP behavior or scope changes.
- Keep review-state semantics explicit. If review states are shown, document which GitHub states are included and how they are mapped in the UI.
- Prefer fixture-backed regression coverage for GitHub DOM behavior and reserve placeholder end-to-end tests for bootstrapping only.

## Workflow

1. Inspect the relevant files before changing behavior.
2. Make focused changes that fit the current product scope.
3. Run the narrowest useful validation available.
4. Use conventional commits with small, reviewable scope.
5. Push `main` only when changes are intentional and validated as far as practical.

## Chrome Web Store Release Safety

- Treat `.github/workflows/release.yml` and
  `docs/chrome-web-store.md` as the canonical release automation and runbook.
- A pushed `v<version>` tag submits the checked Chrome package through the
  Chrome Web Store API v2 and requests automatic publication after approval.
- Keep manual workflow runs safe by default: `chrome_web_store: skip` must
  remain the default, `dry-run` is for credential validation, and `publish`
  must be selected intentionally.
- Run the credential-only `dry-run` after changing Chrome Web Store
  credentials, service-account linkage, the submission dependency, or the
  publish steps in `release.yml`.
- Never read, print, echo, commit, or write Chrome Web Store credential values
  to logs or repository files. Store the private key directly in
  `CWS_SERVICE_ACCOUNT_PRIVATE_KEY`; do not derive it from a complete JSON
  secret because derived values may bypass GitHub's masking. Checking that the
  secret exists is allowed; its contents are not.
- Do not bypass `pnpm zip:checked` or restore routine manual package uploads.
  Dashboard listing metadata, screenshots, privacy disclosures, and exceptional
  recovery actions remain manual.
- Keep `README.md`, `docs/chrome-web-store.md`, and
  `docs/chrome-web-store-submission.md` synchronized when release behavior or
  store submission requirements change.

## Commands

```bash
pnpm install
pnpm prepare
pnpm dev
pnpm build
pnpm zip
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
```

## Commit Conventions

- `feat:` for user-facing functionality
- `fix:` for bug fixes
- `refactor:` for internal restructuring without behavior change
- `docs:` for documentation only
- `test:` for test-only changes
- `chore:` for tooling, config, and repository maintenance
- `perf:` for performance improvements without behavior change
- `build:` for build system, dependencies, and release packaging
- `ops:` for CI, release workflows, and infrastructure
- `style:` for formatting and whitespace-only changes

Prefer multiple small commits over one mixed commit. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the full contribution
workflow, including branch naming.

## Pull Request Policy

Title rules, body sections, issue linkage, and the co-location
checklist are governed by
[`docs/guidelines/pr-guideline.md`](./docs/guidelines/pr-guideline.md).
Before running `gh pr create`, confirm the body matches
[`.github/pull_request_template.md`](./.github/pull_request_template.md):
every PR body must include `## Summary`, `## Why`, `## Changes`,
`## Impact`, `## Testing`, `## Breaking Changes`, and
`## Related Issues`. For `## Impact`, `## Testing`, and
`## Breaking Changes`, sections that do not apply still belong in
the body — mark them "None", "N/A", or "not applicable" so
reviewers see they were considered. `## Related Issues` is not
one of those optional sections; it must always carry one of
`Resolves #123`, `Part of #123`, or `No issue: <reason>` per the
[Issue linkage](./docs/guidelines/pr-guideline.md#issue-linkage)
rules. `gh pr create --body` bypasses GitHub's template
auto-population, so the template must be applied manually.

## Review Standard

- Call out scope creep early.
- Prioritize breakage risks from GitHub DOM changes, API rate limits, auth handling, and regression coverage.
- If a task cannot be fully verified, state exactly what was not run or not confirmed.
- Keep repository docs synchronized with the implemented MVP instead of leaving roadmap text stale.
