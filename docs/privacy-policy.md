# Privacy Policy

Last updated: 2026-04-23

`GitHub Pulls Show Reviewers` is a Chrome extension that shows requested reviewers, requested teams, and completed review state directly inside GitHub pull request list pages.

## What the extension accesses

The extension runs only on `https://github.com/*` pages that match repository routes and requests reviewer data from `https://api.github.com/*`.

To provide its reviewer visibility feature, the extension may access:

- GitHub repository and pull request context from the current page, including repository owner/name, pull request numbers, and visible metadata needed to place reviewer chips in the list UI.
- Reviewer-related metadata returned by GitHub's REST API, including requested reviewers, requested teams, and review states.
- User-to-server access tokens and refresh tokens issued by GitHub after you
  sign in with our GitHub App (requested permission: `Pull requests: Read`).
  These credentials are revocable from
  [github.com/settings/applications](https://github.com/settings/applications).

## How data is used

- GitHub page context is used locally to determine which repository and pull requests are visible on the current page.
- Reviewer metadata is requested from GitHub's API and rendered inline on the GitHub pull request list page.
- The GitHub App credentials are used only to authenticate requests to GitHub for private repository access and to refresh expired access tokens.

## Storage and retention

- Connected accounts are stored locally in `browser.storage.local`. The
  `settings` key stores the account id list, and per-account records are split
  across `account:profile:*`, `account:auth:*`, and
  `account:installations:*` keys. These records contain the GitHub login,
  avatar URL, creation timestamp, user-to-server access token, refresh token,
  token expiry timestamps, cached GitHub App installations, and invalidation
  state. Entries live there until the user removes the account.
- Display preferences are stored locally in `browser.storage.local` under a
  separate `preferences` key. That record currently stores whether review-state
  badges stay visible and whether reviewer names expand into text pills. The
  preference record remains until the user changes it or removes the extension.
- Reviewer responses are cached only for the current page session to avoid duplicate fetches while browsing the same pull request list.
- The extension does not operate its own backend, database, analytics pipeline, or advertising system.

## Sharing

- Data needed for reviewer lookups is sent directly to GitHub through `https://api.github.com/*`.
- The developer of this extension does not receive, sell, rent, or broker user data.
- The extension does not share user data with advertisers or unrelated third parties.

## Security and remote code

- The extension does not execute remote code.
- The extension requests only the permissions needed for storage and GitHub page/API access.

## Contact

If you publish this extension, replace this section with the maintainer's support or privacy contact address before submitting to the Chrome Web Store.
