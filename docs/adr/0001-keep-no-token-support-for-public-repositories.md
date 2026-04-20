# ADR 0001: Keep No-Token Support For Public Repositories

- Status: Accepted
- Date: 2026-04-20

## Context

This extension is intentionally narrow: it shows requested reviewers, requested teams, and completed review state directly inside GitHub pull request list pages.

One of the repository's product rules is to prefer public-repository support without a token when possible. The current MVP already reflects that policy in the README, options UI, repository diagnostics, and Chrome Web Store submission materials.

At the same time, the current reviewer fetch path uses two REST requests for each cold pull request row:

1. `GET /repos/{owner}/{repo}/pulls/{n}`
2. `GET /repos/{owner}/{repo}/pulls/{n}/reviews`

This raised the question of whether request volume should be reduced by moving toward a token-required model such as a GraphQL-first implementation.

## Decision

For `v1.0.0`, the product will keep no-token support for public repositories.

Request-volume work must respect that policy. Reducing request count is a valid follow-up goal, but it is not a reason by itself to make tokens mandatory for public repositories.

## Rationale

- The no-token path is an explicit product rule, not an incidental implementation detail.
- Public-repository access without credentials lowers adoption friction and fits the extension's narrow reviewer-visibility purpose.
- The current implementation already limits duplicate work within a page session through in-flight request de-duplication and per-pull caching.
- A GraphQL-first rewrite would introduce a second API model and move the product away from the current public/no-token story.
- Changing this policy would require coordinated updates across user-facing copy, diagnostics UX, release materials, and privacy disclosures.

## Consequences

### Positive

- Public repositories remain usable without forcing users to create or save a token.
- The current options UX and repository diagnostics stay aligned with shipped behavior.
- The Chrome Web Store listing and privacy disclosures remain simpler and more accurate.

### Negative

- Cold rows still cost two REST requests in the current implementation.
- Public browsing remains sensitive to unauthenticated REST availability and rate limits.

## Follow-up Guidance

- `v1.0.0` keeps the existing REST model.
- If request volume becomes a real post-launch issue, prefer page-level batching or other REST-path optimizations before reconsidering the authentication policy.
- Revisit this ADR only if the product direction changes and token-required behavior becomes an intentional scope decision.
