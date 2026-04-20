# GitHub Pulls Show Reviewers

`GitHub Pulls Show Reviewers` is a Chrome extension focused on one job: make reviewer visibility obvious in GitHub pull request lists.

## Product scope

- Show requested user reviewers on GitHub PR list pages
- Show requested team reviewers on GitHub PR list pages
- Show lightweight review state summary for completed reviews
- Stay resilient to GitHub DOM changes by isolating selectors and rendering logic

## Why a rewrite instead of a fork

The original project works, but it is tightly coupled to GitHub DOM classes, performs multiple API calls per row, and has no type safety or automated test coverage. This repository starts from a narrower but more maintainable baseline:

- `WXT` for modern MV3 extension development
- `TypeScript` for typed API and DOM contracts
- `React` only for the options surface, not the content script rendering path
- Dedicated modules for GitHub route parsing, selector management, API access, caching, and reviewer rendering

## Implemented MVP

- Detect GitHub repository pages and activate on PR list routes
- Parse repository route and pull request number from the page
- Load a saved token from extension settings
- Validate a token directly from the settings page before saving or using it
- Optionally validate pull-request access for a specific `owner/name` repository
- Fetch requested reviewers, requested teams, and latest completed review states
- Render inline `Requested` and `Reviewed` reviewer chips in each PR row
- Differentiate `approved`, `changes requested`, `commented`, and `dismissed` review states
- Reuse per-page cache entries to avoid duplicate fetches for the same pull request
- Re-process rows during GitHub SPA navigation and DOM updates
- Ship Chrome-extension icons for packaging and store submission
- Provide a tag-driven release workflow that builds and uploads the Chrome package
- Show endpoint-specific diagnostics for `GET /pulls/{n}` and `GET /pulls/{n}/reviews`
- Keep public repositories on the no-token path when GitHub allows unauthenticated access
- Explain unauthenticated rate-limit failures separately from private-repository access issues
- Let the options page check the same repository diagnostics with or without a saved token

Implementation details live in [docs/implementation-notes.md](./docs/implementation-notes.md).
Chrome Web Store submission copy and packaging notes live in [docs/chrome-web-store.md](./docs/chrome-web-store.md).

## Development

```bash
pnpm install
pnpm prepare
pnpm icons:render
pnpm dev
```

For production:

```bash
pnpm build
pnpm zip
```

## Authentication direction

This rewrite should prefer fine-grained PAT guidance instead of the older classic `repo` scope approach. The extension should work without a token for public repositories when possible, and only ask for credentials when private repository access requires it.

For public repositories, the extension first tries GitHub's unauthenticated REST path. When GitHub blocks that path, the UI should distinguish between:

- Exact endpoint failures on `GET /repos/{owner}/{repo}/pulls/{n}`
- Exact endpoint failures on `GET /repos/{owner}/{repo}/pulls/{n}/reviews`
- Unauthenticated rate-limit exhaustion versus repository or token access problems

Repository diagnostics in the options page currently map the key cases like this:

| Check path | API shape                                      | UX outcome                                                                               |
| ---------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| No token   | `200` on pulls list, pull detail, and reviews  | Confirm that the repository works without a token                                        |
| No token   | `403` with rate-limit message or `remaining=0` | Explain unauthenticated rate limiting and suggest a token for higher limits              |
| No token   | `404` or private-like auth failure             | Explain that the repository or pull request may be private, deleted, or permission-gated |
| Token      | `403` without rate-limit signal                | Explain that the token likely needs `Pull requests: Read` or repository selection        |
