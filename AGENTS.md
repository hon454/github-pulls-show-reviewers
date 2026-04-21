# AGENTS.md

## Purpose

This repository builds a Chrome extension that improves one workflow: show reviewer information directly inside GitHub pull request list pages.

Agents working in this repository should preserve that narrow product scope. Do not expand the product into a general PR dashboard unless the user explicitly asks for it.

## Product Rules

- Optimize for reviewer visibility first.
- Keep the initial UX centered on requested reviewers, requested teams, and completed review state.
- Treat unrelated PR metadata such as checks, mergeability, assignees, or labels as out of scope unless the user approves a scope change.
- Prefer public-repository support without a token when possible.
- For private repositories, guide the product toward classic PAT usage (`public_repo` for public-only access, `repo` for private access) and remind users to authorize SSO per organization. A GitHub App flow is the intended long-term replacement and is tracked separately.

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
  GitHub-specific routing, selectors, and API access.
- `src/features/reviewers/`
  Reviewer-focused feature orchestration and rendering.
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
- `docs:` for documentation only
- `chore:` for tooling, config, and repository maintenance
- `test:` for test-only changes
- `refactor:` for internal restructuring without behavior change

Prefer multiple small commits over one mixed commit.

## Review Standard

- Call out scope creep early.
- Prioritize breakage risks from GitHub DOM changes, API rate limits, auth handling, and regression coverage.
- If a task cannot be fully verified, state exactly what was not run or not confirmed.
- Keep repository docs synchronized with the implemented MVP instead of leaving roadmap text stale.
