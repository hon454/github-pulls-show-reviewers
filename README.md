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
- Fetch requested reviewers, requested teams, and latest completed review states
- Render inline `Requested` and `Reviewed` reviewer chips in each PR row
- Differentiate `approved`, `changes requested`, `commented`, and `dismissed` review states
- Reuse per-page cache entries to avoid duplicate fetches for the same pull request
- Re-process rows during GitHub SPA navigation and DOM updates

Implementation details live in [docs/implementation-notes.md](./docs/implementation-notes.md).

## Next milestones

### V1.1

- Better public-repository fallback messaging
- Private/public repository guidance that is specific to the current repo
- Repository-aware token validation flow in settings

### V1.2

- DOM fixture regression coverage
- Playwright extension-level rendering tests
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
