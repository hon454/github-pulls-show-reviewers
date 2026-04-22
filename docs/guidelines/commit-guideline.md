# Commit Guideline

This repository follows Conventional Commits with a small set of rules
adapted from broader internal practice. Keep commits small, readable,
and easy to revert.

## Header

Format:

    <type>(<scope>): <subject>

- Type is required and lowercase.
- Scope is optional, lowercase, and scoped to one subsystem (e.g.
  `reviewers`, `storage`, `github`, `options`, `content`, `ci`).
- Subject is imperative ("add", "fix", "remove"), no trailing period,
  maximum 80 characters.
- One concern per commit. If a change mixes unrelated edits, split them.

## Types

| Type | Use for |
| --- | --- |
| `feat` | User-facing functionality or behavior change |
| `fix` | Bug fix that changes observable behavior |
| `refactor` | Internal restructuring with no behavior change |
| `docs` | Documentation-only changes |
| `test` | Test-only changes (no production code change) |
| `chore` | Tooling, config, and repository maintenance |
| `perf` | Performance improvement with no behavior change |
| `build` | Build system, dependencies, bundler, release packaging |
| `ops` | CI, release workflows, infrastructure |
| `style` | Formatting, whitespace, lint-only (no logic change) |

Pick the type that most accurately describes the change. Branch prefixes
(see [Branch naming](../../CONTRIBUTING.md#branch-naming) in
`CONTRIBUTING.md`) do not constrain commit types — a `chore/`-prefixed
branch can carry any commit type when that type more accurately describes
the change.

## Body

- Leave a blank line between subject and body.
- Wrap lines at 80 characters.
- Explain **why** the change was made. Grouping by behavior is fine;
  do not produce a file-by-file changelog.
- If the change closes a GitHub Issue, use `Resolves #123`. See the
  [PR Guideline](./pr-guideline.md#issue-linkage) for the full set of
  linkage forms used in PR bodies.

## Breaking changes

If the commit introduces a backwards-incompatible change:

- Append `!` after the type/scope in the header:
  `feat(reviewers)!: drop dismissed-state chips`
- Include a `BREAKING CHANGE:` paragraph in the body describing the
  break and the migration path.

Both markers are required. The `!` keeps the header self-describing;
the `BREAKING CHANGE:` paragraph documents the details.

## Local checks

This repository does not run any pre-commit or commit-msg hooks. Run
the available checks manually before committing or pushing:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm verify:release` (before tagging a release)

CI runs `pnpm typecheck` on every PR.

## Examples

Good:

    feat(reviewers): add team reviewer chip
    fix(github): handle 404 when PR list route is stale
    refactor(storage): extract account resolver into its own module
    docs(contrib): add commit and PR guidelines

Avoid:

    update code            # no type, no subject discipline
    Fix bug.               # trailing period, non-imperative, no type
    feat: stuff            # vague subject
    chore: lots of things  # mixed concerns — split instead
