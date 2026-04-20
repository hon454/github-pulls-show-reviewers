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

## Planned milestones

### MVP

- Detect GitHub PR list pages
- Parse repo and PR metadata from the page
- Load GitHub token from options
- Fetch requested reviewers and latest completed review states
- Render reviewer chips inline inside each PR row

### V1.1

- Cache reviewer payloads per page load
- Better error states for `401`, `403`, missing token, and rate limiting
- Public repo fallback when no token is present

### V1.2

- Playwright regression tests against fixture HTML
- Selector fallback strategy for GitHub UI changes
- Chrome Web Store packaging and release workflow

## Development

```bash
pnpm install
pnpm prepare
pnpm dev
```

For production:

```bash
pnpm build
pnpm zip
```

## Authentication direction

This rewrite should prefer fine-grained PAT guidance instead of the older classic `repo` scope approach. The extension should work without a token for public repositories when possible, and only ask for credentials when private repository access requires it.
