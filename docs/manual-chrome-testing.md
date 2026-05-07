# Manual Chrome Testing

This repository already documents packaging and automated validation, but it did not have a focused guide for testing the built extension manually in Chrome with the real MV3 output.

This guide uses the repository's built artifact at `.output/chrome-mv3`, which is the same unpacked directory used by the Playwright extension tests.

Chrome's official unpacked-extension flow is documented here:

- [Hello World extension: Load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)

Chrome's official reload behavior is documented here:

- [Hello World extension: Reload the extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#reload)

## When to use this guide

Use this flow when you want to validate the real extension bundle in Chrome before release, before store submission, or after changing reviewer rendering behavior.

## 1. Build the extension output

From the repository root:

```bash
pnpm install
pnpm prepare
pnpm build
```

Expected unpacked extension directory:

```text
.output/chrome-mv3
```

If icons changed, regenerate them before the build:

```bash
pnpm icons:render
```

## 2. Load the built artifact in Chrome

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Select the repository directory `.output/chrome-mv3`.

If the load succeeds, Chrome will add a local unpacked extension card for `GitHub Pulls Show Reviewers`.

## 3. Open a GitHub pull request list page

Open a repository PR list route such as:

```text
https://github.com/<owner>/<repo>/pulls
```

Good manual checks:

- A public repository with open pull requests, to validate the no-token path.
- A private repository you can access, to validate the device-flow authenticated path.

This extension is intentionally narrow. Manual verification should stay focused on reviewer visibility:

- Requested reviewers render inline on PR rows.
- Requested teams render inline on PR rows.
- Completed review state prefers the latest non-`COMMENTED` review for each reviewer, and falls back to the latest `COMMENTED` review only when no non-comment review exists.
- A still-requested reviewer with prior `APPROVED`, `CHANGES_REQUESTED`, or `DISMISSED` evidence shows the refresh badge only when a later `review_requested` event confirms re-review.
- A reviewer who remains in `requested_reviewers` after submitting `APPROVED`, `CHANGES_REQUESTED`, or `DISMISSED`, with no later `review_requested` event, renders the completed review state.
- No unrelated PR dashboard data appears.
- Display preference changes should rerender from cache rather than refetch reviewer API data.
- Re-requested reviewers or teams should update after GitHub rerenders the PR
  list, without requiring a full browser reload.

## 4. Verify the main user flows

### Public repository path

1. Visit a public GitHub repository pull request list.
2. Confirm reviewer chips appear without configuring a token.
3. Confirm the UI shows only reviewer-focused metadata:
   requested reviewers, requested teams, and completed review state.

### Signed-in, all-repos installation

1. Open the extension options page.
2. Confirm the page loads actual UI content and does not render as a blank
   white screen.
3. If this build was intentionally packaged without the GitHub App config,
   confirm the page shows the explicit configuration warning instead of the
   sign-in controls.
4. Otherwise, click **+ Add another account**; the panel opens and
   requests a device code automatically. Complete the device flow
   with an account where the GitHub App is installed on
   **All repositories**.
5. Visit a private PR list in that account's namespace.
6. Confirm reviewer chips render for every row without an `app-uncovered` banner.

### Signed-in, selected-repos installation

1. Install the GitHub App on an organization with only two selected
   repositories.
2. Complete the device flow with the owning user.
3. Visit one of the two selected repositories' PR list; confirm reviewer chips
   render.
4. Visit a third repository in that org; confirm an empty reviewer slot per row
   and a banner prompting to add access.

### App-uncovered banner

1. Sign in but do not install the App on `work-org`.
2. Visit a `work-org` PR list.
3. Confirm the top-of-page banner surfaces `work-org` and offers an Install
   link that routes to the App installation page.
4. Click **Dismiss**. Confirm the banner stays dismissed on reload of the same
   URL and reappears on a different PR list path.

### Revoked account

1. On github.com → Settings → Applications, revoke the authorization for the
   test App.
2. Reload a private PR list.
3. Confirm the row reviewer slots become empty and the banner prompts to sign
   in again.
4. Open the options page; confirm the account card shows the invalidated
   styling and a **Sign in again** button.
5. Click **Sign in again** and complete the device flow with the same GitHub
   account. Confirm the invalidated card is replaced in place — there should
   still be exactly one card for that login, with the same position in the
   list, not a new second card with a duplicate login.

### Expired access token with valid refresh token

1. Sign in with a private-repository account and confirm reviewer chips render.
2. Open `chrome.storage.local` in the extension's service worker DevTools.
3. Replace the stored `account:auth:<id>.token` value with a known-bad token
   while keeping `refreshToken` intact.
4. Reload the private PR list.
5. Confirm reviewer chips still render and the extension performs exactly one
   refresh-token exchange against `https://github.com/login/oauth/access_token`.
   The reviewer fetch now retries from the background worker, so this check
   belongs in the extension service worker DevTools rather than the page
   DevTools alone.
6. Open the options page and click **Refresh installations**.
7. Confirm the installation refresh also succeeds without requiring a fresh
   sign-in.
8. In the options page, enter a covered repository and click
   **Check matched account**. Confirm diagnostics reports success — it uses
   the same refresh path as the runtime, so a stale access token must not
   produce a false negative here.

### Expired access token with invalid refresh token

1. Starting from the previous scenario, also corrupt
   `account:auth:<id>.refreshToken`.
2. Reload the private PR list.
3. Confirm the account is marked invalidated with
   `invalidatedReason: "refresh_failed"` and the UI prompts for sign-in again.

### Unauthenticated rate limit

1. Sign out of every account in the options page.
2. Refresh a public PR list many times in quick succession to exhaust GitHub's
   unauthenticated rate limit.
3. Confirm row reviewer slots become empty and the banner shows the sign-in CTA
   that opens the options page.

### Display preference rerender

1. Open a GitHub PR list and open DevTools on the **Network** tab.
2. Filter requests to `/pulls/` and `/reviews` so reviewer API traffic is easy to spot.
3. Confirm the default UI shows the merged `Reviewers:` row with avatar chips.
4. Open the extension options page in another tab and enable **Show reviewer names**.
5. Return to the PR list and confirm reviewer chips expand into `@login` pills.
6. Confirm no new reviewer API requests appear in DevTools after the toggle.

### Reviewer freshness after GitHub rerender

1. Open a PR list for a repository where you can edit review requests.
2. Open one pull request from the list in another tab, request or remove a
   reviewer or team, then return to the PR list tab.
3. Trigger GitHub's normal list rerender by navigating away and back within the
   same repository, using browser back/forward, or refreshing the PR list's
   filters.
4. Confirm the row keeps its existing reviewer chips visible while the extension
   revalidates in the background.
5. Confirm the changed reviewer or team state appears without a full browser
   page reload.

## 5. Rebuild and reload during iteration

The official Chrome docs note that manifest changes, service worker changes, and content script changes require an extension reload, and content script changes also require reloading the host page.

For this repository, the safest loop after any code change is:

```bash
pnpm build
```

Then:

1. Go back to `chrome://extensions`.
2. Click the extension card's reload icon.
3. Refresh the GitHub PR list tab.

Use this full loop for any change that affects:

- `entrypoints/content.ts`
- `entrypoints/background.ts`
- `src/features/reviewers/`
- `src/github/`
- `src/storage/`
- `wxt.config.ts`
- `manifest`-related output

## 6. Recommended manual regression checklist

Before considering a manual check complete, verify at least these cases:

- Reviewer chips appear on a normal PR list row.
- A requested team is shown with the expected team label format.
- A reviewer with `APPROVED`, `CHANGES_REQUESTED`, or `DISMISSED` followed by a later `COMMENTED` review still renders the non-comment state.
- A reviewer with only `COMMENTED` reviews renders the latest `COMMENTED` state.
- A still-requested reviewer with prior `APPROVED`, `CHANGES_REQUESTED`, or `DISMISSED` evidence renders the refresh badge when a later `review_requested` event exists.
- A stale requested reviewer whose latest `review_requested` event predates the latest non-comment review renders the completed review state, such as `changes requested`.
- Toggling **Show reviewer names** rerenders the current PR list without extra reviewer API requests.
- GitHub SPA navigation still leaves reviewer chips visible after moving between PR list views.
- A changed review request is revalidated after same-repository GitHub
  navigation or rerender, without requiring a full browser reload.
- Reloading the page does not duplicate reviewer UI on the same row.
- The options page never falls back to a blank white screen; a misconfigured
  production build shows an explicit GitHub App configuration warning instead.

## 7. Troubleshooting

If the extension appears loaded but does not work:

- Confirm you loaded `.output/chrome-mv3`, not the repository root.
- Confirm `pnpm build` completed after your latest code changes.
- Reload the extension in `chrome://extensions`.
- Refresh the GitHub page after reloading.
- Open the `Errors` button on the extension card in `chrome://extensions` if Chrome reports runtime issues.
- For content-script debugging, inspect the target GitHub page in DevTools and check the console for extension-related errors.
- For authenticated reviewer-fetch debugging, also inspect the extension
  service worker DevTools because the private-repository GitHub fetch and
  refresh-retry path now run there.

If reviewer data is missing only on private repositories:

- Re-check that the signed-in account has the GitHub App installed for the target repository.
- Use the options page diagnostics to confirm the same GitHub API paths used by the background reviewer fetch can be reached.
