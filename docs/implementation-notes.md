# Implementation Notes

## Current MVP behavior

- The content script runs on GitHub repository pages and activates on pull request list routes.
- Each PR row is inspected for its pull request number.
- Reviewer data is loaded from the GitHub pull request and reviews REST endpoints.
- Requested reviewers and completed reviewers are rendered as inline chips.
- Completed reviews are color-coded by latest visible review state.
- Reviewer links point back to repo-scoped GitHub pull request searches.
- Reviewer payloads are cached per page session to avoid duplicate requests for the same pull request.
- Settings store multiple token entries, each scoped to either `owner/*` or `owner/repo`.
- The options page can validate a token against the GitHub API before saving it.
- The options page leaves the repository diagnostics input empty by default, resolves the best matching stored token for `owner/repo`, and provides a shortcut link to GitHub's classic PAT creation page along with an SSO authorization reminder.
- Repository diagnostics can discover one pull request and verify the exact detail and reviews endpoints used by the content script, both with the matched token and on the no-token path.
- The packaged extension now includes dedicated `16/32/48/128` icons under `public/icon/` for Chrome surfaces and store submission.

## Runtime flow

1. Parse the current repository route from `window.location.pathname`.
2. Find PR rows with centralized GitHub selectors.
3. Extract the pull request number from the row id or primary pull request link.
4. Load settings from `browser.storage.local`.
5. Resolve the best matching token scope for the current `owner/repo`.
6. Fetch reviewer data from GitHub only when the cache is cold.
7. Use the matched token only; do not auto-fallback to another token or to no-token when a matched token fails.
8. Render `Requested` and `Reviewed` sections inline in the PR row metadata area.
9. Re-run row processing when GitHub mutates the page or performs SPA navigation.

## Current limitations

- The extension still depends on GitHub metadata DOM structure.
- API requests are still one pull request plus one reviews request per uncached row.
- Public-repository no-token access still depends on GitHub's unauthenticated REST availability and rate limits.
- Legacy single-token settings are not migrated and must be re-added as scoped entries.

## Request volume decision

- ADR: [0001 - Keep No-Token Support For Public Repositories](./adr/0001-keep-no-token-support-for-public-repositories.md)
- `v1.0.0` keeps the current `pull + reviews` REST model for cold rows.
- The current implementation already de-duplicates in-flight row fetches and caches each pull request summary for the active page session, so the immediate duplication risk is contained.
- A GraphQL-first rewrite is not the next step because it would push the product away from the current no-token public-repository path and add a second transport model to maintain.
- If request volume becomes the next real bottleneck after launch, the preferred follow-up is a page-level batch strategy on the existing REST path before considering a broader API migration.

## Repository diagnostics matrix

The current repository-check UX is intentionally narrow and pinned by fixture-backed tests:

| Mode     | Response pattern                               | Reported UX                                                                    |
| -------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| No token | `200` for pulls list, pull detail, and reviews | Repository works on the public no-token path                                   |
| No token | `403` with rate-limit signal                   | Unauthenticated rate limit exhausted                                           |
| No token | `404`, `401`, or private-like `403`            | Repository or pull request behaves like a private or permission-gated resource |
| Token    | `403` without rate-limit signal                | Classic PAT is missing the `repo` scope or the organization requires SSO authorization |

## Next implementation targets

- Collapse request volume further where practical.
- Add more fixture-backed extension boot coverage for GitHub DOM variants.
