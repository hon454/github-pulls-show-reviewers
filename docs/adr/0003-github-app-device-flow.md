# ADR 0003: GitHub App + Device Flow

- Status: Accepted — token lifecycle amended by [ADR 0004](./0004-github-app-token-refresh.md)
- Date: 2026-04-21

## Context

[ADR 0002](./0002-classic-pat-interim-auth.md) shipped Classic PAT support as an
interim unblock for users in organizations that disallow fine-grained PATs. It
explicitly called the long-term direction a GitHub App plus device flow.

The long-term direction is now ready. Classic PAT support leaves the extension
holding a token with broader scope than it needs, makes per-organization SSO
authorization the user's problem, and offers no authoritative way to tell
whether a token actually covers a given repository.

## Decision

Ship a maintainer-owned GitHub App plus OAuth Device Flow.

- Store multiple accounts in `browser.storage.local` under a single versioned
  `settings` key. Each account caches its installations (`all` or `selected`
  with explicit full names).
- Run device code polling on the options page because MV3 service workers
  unload on idle.
- Resolve repository access via `resolveAccountForRepo(owner, repo)` using
  the cached installations — no user-typed scope patterns.
- Remove all PAT-era code, storage, copy, and tests.
- Preserve the no-token public-repository path from [ADR 0001](./0001-keep-no-token-support-for-public-repositories.md).

## Rationale

- Scope shrinks from Classic PAT `repo` to GitHub App `Pull requests: Read`.
- Per-organization SSO authorization disappears as a user step; installation
  acceptance is the single gate.
- Installation data gives authoritative coverage rather than relying on user
  scope patterns.
- The flow never needs a client secret: GitHub's device-flow grant-type
  exchange does not require one, and the extension stays purely client-side.
- Multi-account storage matches how GitHub itself models access and avoids a
  second migration when users need both a personal and a work account.

## Consequences

### Positive

- Narrower scope, smaller blast radius.
- No per-token SSO authorization dance.
- Installation-based matching is authoritative and easy to refresh.
- Fewer moving pieces on the rendering side: row-level failure text goes away;
  a single banner handles install guidance.

### Negative

- Some organizations require admin approval for GitHub App installation. Users
  blocked by strict policies rely on the no-token public path.
- User-to-server tokens have no refresh in a pure-client setting (the refresh
  endpoint requires a client secret). Users sign in again when a token is
  revoked — detected lazily and surfaced through the banner and options page.
  *(Amended by [ADR 0004](./0004-github-app-token-refresh.md): GitHub's
  device-flow refresh grant does work without a client secret; the extension
  now exchanges refresh tokens in the service worker before invalidating.)*

### Neutral

- No backend proxy. The extension remains client-side.
- PAT-era saved tokens are not migrated; the v2 settings shape overwrites
  legacy `tokenEntries` payloads with an empty account list.

## Links

- [ADR 0001](./0001-keep-no-token-support-for-public-repositories.md) — no-token
  public path, preserved.
- [ADR 0002](./0002-classic-pat-interim-auth.md) — superseded by this ADR.
