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
- A private repository you can access, to validate the fine-grained PAT flow from the options page.

This extension is intentionally narrow. Manual verification should stay focused on reviewer visibility:

- Requested reviewers render inline on PR rows.
- Requested teams render inline on PR rows.
- Completed review state renders from each reviewer's latest visible review.
- No unrelated PR dashboard data appears.

## 4. Verify the main user flows

### Public repository path

1. Visit a public GitHub repository pull request list.
2. Confirm reviewer chips appear without configuring a token.
3. Confirm the UI shows only reviewer-focused metadata:
   requested reviewers, requested teams, and completed review state.

### Private repository path

1. Open the extension's options page from the extension card in `chrome://extensions`, or from the Chrome extensions menu.
2. Add a fine-grained PAT scoped to the owner or repository you want to test.
3. Keep permissions minimal:
   `Pull requests: Read`.
4. Save the token and use the repository diagnostics UI if needed.
5. Re-open the private repository PR list and confirm reviewer chips now render through the authenticated path.

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
- A completed review shows the latest visible state for that reviewer.
- GitHub SPA navigation still leaves reviewer chips visible after moving between PR list views.
- Reloading the page does not duplicate reviewer UI on the same row.
- Private-repository access does not require broader token permissions than `Pull requests: Read`.

## 7. Troubleshooting

If the extension appears loaded but does not work:

- Confirm you loaded `.output/chrome-mv3`, not the repository root.
- Confirm `pnpm build` completed after your latest code changes.
- Reload the extension in `chrome://extensions`.
- Refresh the GitHub page after reloading.
- Open the `Errors` button on the extension card in `chrome://extensions` if Chrome reports runtime issues.
- For content-script debugging, inspect the target GitHub page in DevTools and check the console for extension-related errors.

If reviewer data is missing only on private repositories:

- Re-check that the stored PAT matches the target `owner/repo` or `owner/*`.
- Re-check that the token has repository access and `Pull requests: Read`.
- Use the options page diagnostics to confirm the same GitHub API paths used by the content script can be reached.
