# ADR 0002: Classic PAT Interim Auth

- Status: Superseded by [ADR 0003](./0003-github-app-device-flow.md) (2026-04-21)
- Date: 2026-04-21

## Context

The extension has been guiding users toward GitHub fine-grained personal access tokens for private repository access. Fine-grained PATs require the target organization to opt into fine-grained tokens at the organization policy level. Some organizations — including the motivating case `cinev/shotloom` — have not enabled fine-grained PAT access, which leaves affected users unable to configure the extension for private repositories in those organizations.

At the same time, the product's long-term authentication direction is a GitHub App plus device flow, which restores fine-grained, per-repository read-only scopes with better UX than a PAT. That work is tracked separately and is not ready to ship.

## Decision

Replace fine-grained PAT guidance with Classic PAT guidance as an interim step.

- The options page, validation error copy, README, privacy policy, Chrome Web Store materials, implementation notes, and manual testing guide all move to Classic PAT wording.
- The stored token format (`TokenEntry` with `id`, `scope`, `token`, `label`) and the `Authorization: Bearer <token>` request shape are unchanged.
- The no-token public-repository policy recorded in [ADR 0001](./0001-keep-no-token-support-for-public-repositories.md) is unchanged.

## Rationale

- Classic PATs do not require organization-level opt-in for the token to exist. They only require per-organization SSO authorization, which is a user action on the token settings page.
- This directly unblocks users in organizations that disallow fine-grained PATs.
- The interim cost is that the Classic PAT `repo` scope is broader than the fine-grained `Pull requests: Read` permission. The extension only performs read operations, and the guidance states that explicitly.
- Because tokens are validated through the same `Authorization: Bearer` header, existing saved tokens continue to work without migration. There is no settings-schema change.
- OAuth App support was considered and rejected during brainstorming because it offers no advantage over Classic PAT for this product and adds an OAuth flow the extension does not otherwise need.

## Consequences

### Positive

- Users in organizations that disallow fine-grained PATs can complete private-repository setup by creating a Classic PAT and authorizing SSO.
- Validation error text now surfaces the actual unblock (SSO authorization) for 401/403 failures against repository endpoints with a saved token.
- Existing users who already saved a fine-grained PAT keep working, because GitHub accepts both styles at the `Authorization: Bearer` layer.

### Negative

- Classic PAT scopes are broader than fine-grained `Pull requests: Read`. The product mitigates this through explicit copy that the extension is read-only and by recommending `public_repo` whenever the user's usage is public-only.
- Users who preferred the fine-grained flow temporarily lose it. The long-term GitHub App work is the intended recovery path.

## Follow-up Guidance

- PAT support as a whole will be removed when GitHub App + device flow support ships. That work is tracked as a separate spec and is not part of this decision.
- `cinev/shotloom`-style organizations may still block Classic PAT via SSO policy. Document as a known limitation and revisit when GitHub App work begins. The fallback remains the no-token path for public repositories.
- Revisit this ADR when GitHub App support is ready to ship. At that point, replace this ADR's status with `Superseded`, link to the follow-up ADR, and remove PAT wording from the product.
