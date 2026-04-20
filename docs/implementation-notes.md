# Implementation Notes

## Current MVP behavior

- The content script runs on GitHub repository pages and activates on pull request list routes.
- Each PR row is inspected for its pull request number.
- Reviewer data is loaded from the GitHub pull request and reviews REST endpoints.
- Requested reviewers and completed reviewers are rendered as inline chips.
- Completed reviews are color-coded by latest visible review state.
- Reviewer links point back to repo-scoped GitHub pull request searches.
- Reviewer payloads are cached per page session to avoid duplicate requests for the same pull request.
- The options page can validate a token against the GitHub API before saving it.
- Repository diagnostics can verify pull-request access for a specific `owner/name`.

## Runtime flow

1. Parse the current repository route from `window.location.pathname`.
2. Find PR rows with centralized GitHub selectors.
3. Extract the pull request number from the row id or primary pull request link.
4. Load settings from `browser.storage.local`.
5. Fetch reviewer data from GitHub only when the cache is cold.
6. Render `Requested` and `Reviewed` sections inline in the PR row metadata area.
7. Re-run row processing when GitHub mutates the page or performs SPA navigation.

## Current limitations

- The extension still depends on GitHub metadata DOM structure.
- API requests are still one pull request plus one reviews request per uncached row.
- Repository access checks validate pull-request listing access, not every GitHub API permission edge case.

## Next implementation targets

- Collapse request volume further where practical.
- Improve public-repository fallback messaging.
- Add richer endpoint-specific permission diagnostics and more GitHub DOM fixtures.
