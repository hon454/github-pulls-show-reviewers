# Chrome Web Store Submission Packet

This file turns the store notes into concrete submission materials for the current MVP.

## Listing fields

Title:
`GitHub Pulls Show Reviewers`

Short description:
`See requested reviewers, teams, and completed review state directly in GitHub pull request lists.`

Detailed description:

`GitHub Pulls Show Reviewers keeps reviewer context visible on GitHub pull request list pages. It adds a single inline Reviewers section with requested reviewers, requested teams, and each reviewer's latest completed review state without turning the page into a general PR dashboard.`

`The extension is designed for a narrow workflow: reviewer visibility first. It caches reviewer lookups per page, revalidates stale reviewer rows as GitHub updates the list, lets users toggle reviewer names and state badges from the options page, keeps GitHub selectors isolated for DOM resilience, and uses a sign-in-with-GitHub flow (via our GitHub App, with Pull requests: Read access only) when private repositories need authentication. The extension only reads repository data; the only POST requests are to GitHub's OAuth device-flow endpoints for sign-in and access-token refresh.`

Suggested category:
`Developer Tools`

Suggested language:
`English (United States)`

## Screenshot inventory

Chrome's listing guidance expects at least one screenshot and recommends up to five. Upload these screenshots to the Chrome Web Store dashboard in this order:

- `01-pr-list-before-after.png`
  Dashboard caption: `Before and after: reviewer chips added directly to the GitHub pull request list.`
- `02-pr-list-avatar-state-showcase.png`
  Dashboard caption: `Requested reviewers and completed review states shown as avatar chips with outlines and badges.`
- `03-options-repository-check.png`
  Dashboard caption: `Display settings and repository diagnostics on the options page.`

The PR-list screenshots are generated from a deterministic GitHub-style fixture for `hon454/github-pulls-show-reviewers` with synthetic PR titles, authors, reviewer states, and avatar images. They should remain realistic enough for store review while avoiding live dummy PRs, real project data, and unrelated UI noise such as floating help buttons.

Regenerate them with:

```bash
pnpm cws:assets
```

## Privacy practices draft

Use the current shipped behavior, not aspirational behavior.

Single purpose:
`Show requested reviewers, requested teams, and completed review state inside GitHub pull request list pages.`

Permission justification draft:

- `storage`: stores locally the GitHub App accounts (user-to-server access token, refresh token, and token-expiry timestamps per account) so the user can access private repositories. It also stores the review-chip display preferences (`showStateBadge`, `showReviewerName`, and `openPullsOnly`) under the local `preferences` key.
- `alarms`: schedules a recurring 15-minute background task that refreshes GitHub App access tokens ahead of expiry. Without this, every eight-hour token lifetime would force the user to sign in again even while actively using the extension, and reviewer lookups on private repositories would stall until the next sign-in.
- `https://github.com/*`: reads the current GitHub pull request list page to find repository context and render reviewer chips inline.
- `https://api.github.com/*`: fetches requested reviewers, requested teams, and review history from GitHub's REST API. Requests originate from the extension's background service worker; the access token never enters the content-script execution context.

Remote code:
`No, this extension does not execute remote code.`

Conservative data usage draft:

- Authentication information: `Yes`
  Reason: the user may sign in with GitHub via the GitHub App, and the resulting user-to-server token is stored locally for private repository access.
- Website content: `Yes`
  Reason: the extension reads repository and pull request context from GitHub pages and renders reviewer metadata into the page.
- Browsing activity: `Yes`
  Reason: the extension detects when the user is on a GitHub repository pull request list page in order to activate.
- Personal communications, health information, financial/payment information, location, web history outside GitHub, and advertising identifiers: `No`

Certification draft:

- Data is used only for the extension's reviewer-visibility feature.
- Data is not sold.
- Data is not used for creditworthiness or lending decisions.
- Data is not used or transferred for unrelated advertising or marketing.

Sharing draft:

- Requests needed for reviewer lookups go directly to GitHub.
- No extension-operated backend receives user data.
- No data is shared with advertisers or data brokers.

Privacy policy URL:
Host [privacy-policy.md](./privacy-policy.md) at a stable public URL before submission. The Chrome Web Store requires the privacy policy link and the privacy fields to match the shipped behavior.

## Release and upload checklist

1. Ensure the package version is the version you intend to submit. Tag names should follow `v<version>`, for example `v1.0.0`.
2. Run `pnpm verify:release`.
3. Run `pnpm cws:assets` if the submission screenshots need to reflect UI changes.
4. Run `pnpm zip` only after the checks above pass.
5. Upload `.output/*-chrome.zip` in the Chrome Web Store dashboard.
6. Attach the three screenshots listed above, in order, with the dashboard captions from the screenshot inventory.
7. Paste the short description, detailed description, and privacy policy URL.
8. Fill in the privacy fields using the draft above, then reconcile every answer against the shipped permissions and network behavior.
9. If you want review before launch, disable automatic publish and stage the release in the dashboard.
10. After approval, publish the staged version and align the Git tag, GitHub Release, and store version.
11. Open the packaged extension's options page once before upload and confirm it never renders as a blank white screen. A missing GitHub App build config must surface the explicit configuration warning instead.

## Current package target

Expected package path after `pnpm zip`:

```text
.output/github-pulls-show-reviewers-1.7.0-chrome.zip
```
