# Privacy Policy

Last updated: 2026-09-08

This is the canonical published privacy policy for the Chrome Web Store listing.
The public policy URL is
<https://github.com/hon454/github-pulls-show-reviewers/blob/main/docs/privacy-policy.md>.

`GitHub Pulls Show Reviewers` is a Chrome extension that shows requested reviewers, requested teams, and completed review state directly inside GitHub pull request list pages.

## What the extension accesses

The extension runs on `https://github.com/*` pull request list pages and requests reviewer data from `https://api.github.com/*` through its background service worker. The background service worker also schedules a recurring `chrome.alarms` job to refresh GitHub App access tokens ahead of their expiry so that private-repository lookups keep working without requiring a fresh sign-in every eight hours.

To provide its reviewer visibility feature, the extension may access:

- GitHub repository and pull request context from the current page, including repository owner/name, pull request numbers, and visible metadata needed to place reviewer chips in the list UI.
- Reviewer-related metadata returned by GitHub's REST API, including requested reviewers, requested teams, and review states.
- User-to-server access tokens and refresh tokens issued by GitHub after you
  sign in with our GitHub App (requested permission: `Pull requests: Read`).
  These credentials are revocable from
  [github.com/settings/applications](https://github.com/settings/applications).

## How data is used

- GitHub page context is used locally to determine which repository and pull requests are visible on the current page.
- Reviewer metadata is requested from GitHub's API and rendered inline on the GitHub pull request list page. OAuth exchanges, authenticated API calls, diagnostics and credential writes run in the background service worker. Content and options receive only allowlisted account summaries, structured results and sign-in progress; they do not read or receive access tokens, refresh tokens or the OAuth device-code secret. Options displays GitHub's user-facing verification code and link.
- The GitHub App credentials are used only to authenticate requests to GitHub for private repository access and to refresh expired access tokens. Refreshes run both reactively on a `401` response and proactively on a recurring 15-minute background schedule via the `alarms` permission, so tokens stay valid even while no GitHub tab is open.

## Storage and retention

- Connected accounts are stored locally in `browser.storage.local`. The
  `settings` key stores the account id list, and per-account records are split
  across `account:profile:*`, `account:auth:*`, and
  `account:installations:*` keys. These records contain the GitHub login,
  avatar URL, creation timestamp, user-to-server access token, refresh token,
  token expiry timestamps, cached GitHub App installations, selected-repository
  snapshot names plus whether those snapshots were fully paginated,
  invalidation state, and an opaque credential revision used to reject stale
  authentication updates, plus the latest opaque sign-in attempt receipt used to
  recognize an already committed connection after worker interruption. Neither
  identifier is derived from token contents.
  Entries live there until the user removes the account locally, including when
  its credentials have been invalidated. Local removal does not revoke the
  GitHub App authorization.
- Display preferences are stored locally in `browser.storage.local` under a
  separate `preferences` key. That record currently stores whether review-state
  badges stay visible, whether reviewer names expand into text pills, and
  whether reviewer chip links are scoped to open pull requests only. It also
  stores the UI language preference (`auto`, English, Korean, Japanese,
  Simplified Chinese, or Traditional Chinese). Language selection stays local;
  translations are bundled and no translation service receives data. The
  preference record remains until the user changes it or removes the extension.
- Pending sign-in state is stored in trusted `browser.storage.session`, including
  the OAuth device-code secret, user verification code, owning options document,
  opaque attempt/flow IDs, polling interval and original deadline. Cancellation,
  expiry, completion and detected document loss clear the secret fields. Expired
  or abandoned entries are cleaned on subsequent background flow activity or
  worker activation, without a polling alarm. Non-secret terminal records reject
  delayed retries while the document remains present. Session storage clears on
  browser restart; saved accounts remain in local storage.
- Reviewer responses are cached only for the current page session to avoid duplicate fetches while browsing the same pull request list.
- The extension does not operate its own backend, database, analytics pipeline, or advertising system.

## Sharing

- Data needed for reviewer lookups is sent directly to GitHub through `https://api.github.com/*`.
- The developer of this extension does not receive, sell, rent, or broker user data.
- The extension does not share user data with advertisers or unrelated third parties.

## Security and remote code

- On every worker activation, the extension restricts local and session storage
  to Chrome's `TRUSTED_CONTEXTS` before account initialization or sensitive
  operations. This prevents content-script storage access. Chrome also considers
  options a trusted context, so the options guarantee comes from application
  boundaries, schema-validated capabilities and tests, not a separate
  background-only browser permission. UI subscriptions contain sanitized
  snapshots, never raw storage change records.
- These boundaries do not protect against a compromised OS/profile or arbitrary
  code already executing inside a trusted extension page. No host-page token
  theft was demonstrated; this change aligns the implementation with the
  intended credential-ownership policy.
- The extension does not execute remote code.
- The extension requests only the permissions needed for storage and GitHub page/API access.

## Contact

For privacy questions, support requests, or to report a concern about this
extension, open an issue on the maintainer's public GitHub Issues tracker:
<https://github.com/hon454/github-pulls-show-reviewers/issues>.
