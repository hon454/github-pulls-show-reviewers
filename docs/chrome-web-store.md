# Chrome Web Store Notes

## Store assets

- Extension icons are generated from [icon/source.svg](../icon/source.svg).
- Generated PNGs live under `public/icon/`.
- Packaged icon sizes: `16`, `32`, `48`, `128`.
- Rebuild PNG assets with `pnpm icons:render`.
- Chrome Web Store screenshots are generated under [chrome-web-store-assets/](./chrome-web-store-assets/) with `pnpm cws:assets`.

## Suggested listing copy

Short description:
`See requested reviewers, teams, and completed review state directly in GitHub pull request lists.`

Detailed description:

`GitHub Pulls Show Reviewers keeps reviewer context visible on GitHub pull request list pages. It adds inline chips for requested reviewers, requested teams, and each reviewer's latest completed review state without turning the page into a general PR dashboard.`

`The extension is designed for a narrow workflow: reviewer visibility first. It caches reviewer lookups per page, keeps GitHub selectors isolated for DOM resilience, and supports fine-grained personal access tokens with repository-scoped pull-request read access when private repositories need authentication.`

## Release workflow

- GitHub Actions workflow: [release.yml](../.github/workflows/release.yml)
- Trigger options:
  - Push a version tag such as `v1.0.0`
  - Run the workflow manually with `workflow_dispatch`
- The workflow runs `lint`, `typecheck`, `test`, and `zip`.
- Every run uploads the packaged Chrome zip as a workflow artifact.
- Tag-triggered runs also attach the zip to a GitHub Release.

## Manual Chrome Web Store submission checklist

1. Run `pnpm icons:render` if the SVG icon changed.
2. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm cws:assets`, and `pnpm zip`.
3. Upload `.output/github-pulls-show-reviewers-<version>-chrome.zip` to the Chrome Web Store dashboard.
4. Use the short and detailed descriptions above for the store listing.
5. Refresh screenshots so they show reviewer chips on GitHub pull request lists only.
6. Confirm the privacy disclosure matches the shipped behavior:
   no sale of data, no advertising, no remote code, GitHub page access only, and optional fine-grained PAT storage in `browser.storage.local` for private repositories.
7. Keep release tags aligned with the store package version, using `v<manifest-version>` tags such as `v1.0.0`.
8. Confirm the reviewer-only scope in the listing copy still matches the extension and screenshots before submission.

Concrete submission assets and privacy-form draft live in [chrome-web-store-submission.md](./chrome-web-store-submission.md). The publishable privacy policy draft lives in [privacy-policy.md](./privacy-policy.md).
