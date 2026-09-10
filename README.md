# GitHub Pulls Show Reviewers

[![Chrome Web Store Version](https://img.shields.io/chrome-web-store/v/hoocgjopdboeghdkfjlkngkkpbiljggk?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme_badge&utm_campaign=evergreen)
[![Chrome Web Store Users](https://img.shields.io/chrome-web-store/users/hoocgjopdboeghdkfjlkngkkpbiljggk?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme_badge&utm_campaign=evergreen)
[![CI](https://github.com/hon454/github-pulls-show-reviewers/actions/workflows/ci.yml/badge.svg)](https://github.com/hon454/github-pulls-show-reviewers/actions/workflows/ci.yml)

**English** · [한국어](./README.ko.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [日本語](./README.ja.md)

> See requested reviewers, teams, and completed review state directly in GitHub pull request lists.

`GitHub Pulls Show Reviewers` is a Chrome extension for one focused workflow: make reviewer status visible from the pull request list, so you do not need to open every PR just to see who is requested or see completed review state.

![GitHub PR list with inline reviewer chips and review-state badges](./docs/chrome-web-store-assets/02-pr-list-avatar-state-showcase.png)

[v1.18.1 release notes](./docs/releases/v1.18.1.md) (English): reviewer support for classic and Preview repository PR lists, plus development-tool dependency maintenance. The release-preparation full and production dependency audits report zero findings.

## What It Does

- Supports both the classic repository PR list and GitHub’s New Repository Pull Requests Dashboard Preview, detecting the page layout automatically. No extension setting is needed; the global `github.com/pulls` dashboard remains outside the supported scope.
- Shows requested user reviewers on GitHub pull request list rows.
- Shows requested team reviewers on GitHub pull request list rows.
- Shows each reviewer's completed review state: `approved`, `changes requested`,
  `commented`, or `dismissed`. The latest non-comment review takes precedence over
  later comments; comments are used when no non-comment review exists.
- When a requested reviewer also has a completed review, shows a refresh badge
  only when bounded issue-event evidence confirms a later request. If that
  evidence is incomplete or unavailable, keeps the requested color and search
  link, retains the previous review in the tooltip and accessible name, and
  hides the refresh badge.
- Links reviewer chips to GitHub PR searches.
- Reuses page-level reviewer metadata across visible rows, including searched
  or paginated pull request lists when GitHub's REST pagination exposes those
  rows.
- Keeps working as GitHub updates the page during normal navigation, including
  restoring an extension mount when equivalent native PR metadata replaces it.
- Keeps reviewer metadata visible in narrow desktop and split-window layouts
  without restoring GitHub metadata that GitHub intentionally hides there.
- Leaves rows visually unchanged when a pull request has no reviewers. If a
  reviewer request fails unexpectedly, shows one page-level reload prompt and
  keeps any previously loaded reviewer chips visible. Failed rows can recover
  when GitHub updates their metadata or the page is refreshed; waiting for an
  API limit to reset does not itself retry reviewer requests. Display and
  language changes only update presentation, including on failed rows.
- Limits each shared repository metadata load and each started reviewer load to
  30 seconds, with a 35-second message safeguard for missing background replies.
  Waiting for one of the four request slots does not count toward the deadline.
  Optional review-request event evidence has a total 10-second limit within the
  parent deadline. If optional evidence times out, confirmed requests remain
  confirmed and other ambiguous requests stay unverified. Mandatory timeouts use
  the same reload prompt and preserve loaded chips; language and display changes
  do not restart deadlines.
- Clears obsolete access guidance after connecting an account or updating its
  installation coverage when every visible reviewer load succeeds. A successful
  row never hides another row's failure or pending request; guidance can downgrade
  as individual rows recover. After a GitHub API limit resets, reload the page
  to retry. Waiting for the reset does not resume reviewer loading automatically.

## Why Use It

GitHub's pull request list is great for scanning titles, authors, and status, but reviewer context can be easy to miss. Without opening each PR, it is hard to tell who is requested, which teams are requested, and each reviewer's completed review state. This extension answers those questions inline by adding a lightweight `Reviewers:` strip to each PR row.

![Before and after reviewer chips on a GitHub PR list](./docs/chrome-web-store-assets/01-pr-list-before-after.png)

## Install

Install the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/github-pulls-show-reviewe/hoocgjopdboeghdkfjlkngkkpbiljggk?utm_source=github&utm_medium=readme&utm_campaign=evergreen).

After installation, open a GitHub repository's pull request list. Public repositories work without signing in. For private repositories, open the extension options page and add the GitHub account that can access the repository.

## Browser and Language Support

Chrome is the only browser this extension currently supports and tests. Other
Chromium-family browsers such as Edge, Brave, and Arc may be able to run the
same MV3 build, but they are not release targets today and are not covered by
the manual Chrome verification flow. Firefox support is also out of scope until
its MV3 behavior, extension packaging, and GitHub sign-in flow are tested
explicitly.

Chrome metadata, options, sign-in, repository diagnostics, reviewer chips, and
access banners support English, Korean, Japanese, Simplified Chinese, and
Traditional Chinese.

## Public and Private Repositories

- **Public repositories:** work without signing in whenever GitHub exposes enough public PR data.
- **Private repositories:** require signing in with GitHub through the extension's GitHub App.
- **Permissions:** the GitHub App requests `Pull requests: Read` only.
- **Repository access:** if GitHub denies access, check the account's repository permissions as well as the GitHub App installation for that owner/repository.
- **Organizations:** an organization owner may need to install or approve the GitHub App before private organization repositories can be read.
- **Multiple accounts:** personal and work accounts can be added side by side. An `all` installation describes App coverage; connected users may still have different repository permissions. After an authenticated repository 403/404 without a rate-limit signal, the extension tries other active accounts for that owner in a bounded sequence: locally covered accounts first, then incomplete selected snapshots, preserving account order within each group. Each account is admitted once per page/repository generation. Successful access is remembered only for that generation; an individual PR's 404 does not reject the whole repository.
- **Retry and diagnostics:** rate limits, unresolved 401, network/schema/server errors and cancellation stop account discovery. A 401 can recover only within the same account. Reload/navigation, reconnecting/removing an account, changed installation coverage or a new explicit diagnostic run can start a new generation. Row updates, cache expiry, token rotation and language/display changes do not reopen failed candidates. Matched diagnostics uses the same policy and shows the account actually used; no-token diagnostics remains anonymous. Public anonymous access and its single unambiguous account fallback are preserved.
- **Session persistence:** sign-in is kept across browser sessions; access tokens are refreshed automatically in the background until you remove the account or revoke the GitHub App.
- **Sign-in recovery:** an in-progress sign-in survives ordinary background worker suspension. If the browser restarts or an exchange is interrupted, request a new code; already connected accounts remain saved.

## Settings

The options page lets you tune the display without changing the core reviewer-focused workflow:

- Show reviewer avatars only, or expand users into `@login` pills.
- Show or hide review-state badges.
- Choose whether reviewer chip links search open PRs only or include closed PRs too.
- Check account, repository access, installation coverage, and rate-limit diagnostics for private repositories.
- During sign-in, localized clipboard feedback confirms copying or provides a manual-copy fallback. Closing the panel restores useful keyboard focus, and a successful connection remains announced in the accounts section. Changing the extension language only reformats this feedback; it does not restart sign-in.

![Display settings and repository diagnostics in the options page](./docs/chrome-web-store-assets/03-options-repository-check.png)

## Privacy

The extension is built around the minimum access needed to show reviewer information on pull request lists.

- Public repository support does not require signing in.
- Private repository support uses GitHub sign-in through the extension's GitHub App.
- The GitHub App requests `Pull requests: Read` only.
- OAuth, authenticated requests and credential storage belong to the background.
  Content and options receive account summaries and user-facing sign-in progress,
  without access tokens, refresh tokens or OAuth device-code secrets.
- Chrome blocks content-script access to local storage. The options boundary is
  enforced by the extension's application code; Chrome still treats options as a
  trusted extension page.
- Removing an active or invalidated account from the options page deletes that
  account's locally stored credentials only.
- To revoke the GitHub App itself, remove it from GitHub's Applications settings.

See the
[public privacy policy](https://github.com/hon454/github-pulls-show-reviewers/blob/main/docs/privacy-policy.md)
for the full policy text.

## Support

If you find this extension useful, consider buying me a coffee!

<a href="https://www.buymeacoffee.com/hon454s" target="_blank" rel="noopener noreferrer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="217" height="60"></a>

## For Contributors

This repository uses WXT, TypeScript, React, zod, Vitest, Playwright, and pnpm.

```bash
pnpm install
pnpm dev
```

Requires Node.js 22.12+ and pnpm 10.x. With WXT 0.21, `pnpm dev` starts the
dev server without opening a browser. In `chrome://extensions`, enable Developer
mode and load `.output/chrome-mv3-dev` as an unpacked extension. Keep the dev
server running. See [dependency audit notes](./CONTRIBUTING.md#dependency-audits)
for why the optional browser runner is excluded.

`pnpm install` runs `wxt prepare` automatically through pnpm's lifecycle, so no separate prepare step is needed.

Useful validation commands:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:e2e
```

Before release packaging or store submission, run:

```bash
pnpm verify:release
pnpm zip:release
```

`pnpm zip` produces an inspectable local build only. Production packaging for the Chrome Web Store uses `pnpm zip:release`, which loads the maintainer GitHub App identifiers and verifies the final zip before upload.

Pushing a new `v<version>` tag attaches the verified package to a GitHub Release
and submits it through CWS API v2 for automatic publication after normal review.
If the exact source already has a validated upload receipt and is pending or
published, the tag reuses that checked package without another CWS write.
Manual workflow runs default to `skip`; credential-only `dry-run` does not
change store state or create a release. Review submission and tagging require
explicit authorization. Follow the [Chrome Web Store notes](./docs/chrome-web-store.md)
and [canonical agent runbook](./docs/chrome-web-store-agent-runbook.md) for staging,
legacy tags, listing updates, verification evidence, and recovery procedures.

Read-only `status` produces a sanitized JSON report and Actions Summary for
API state, trusted receipts and the next release action, without building or
changing the store. Ordinary package releases reuse a verified saved-listing
baseline when all five descriptions and their screenshots are unchanged; browser
access and repeated dashboard saves are unnecessary. Changed listings use the
staged procedure; missing or conflicting evidence requires targeted
reconciliation. Status reports are observations, not authorization, and later
writes always repeat the guarded checks.

For repository workflow, branch naming, commit style, and pull request requirements, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Documentation

The README is available in all five supported languages. The detailed technical,
contribution, and operational documents linked below are maintained in English.

- [Documentation and README translation guidelines](./docs/guidelines/documentation-guideline.md)
- [Implementation notes](./docs/implementation-notes.md)
- [Manual Chrome testing](./docs/manual-chrome-testing.md)
- [Chrome Web Store notes](./docs/chrome-web-store.md)
- [Chrome Web Store submission packet](./docs/chrome-web-store-submission.md)
- [Chrome Web Store agent runbook](./docs/chrome-web-store-agent-runbook.md)
- [Staged CWS action reference](./docs/cws-agent-handoff.md)
- [Store acquisition attribution](./docs/growth/attribution.md)
- [Launch and community copy](./docs/growth/launch-kit.md)
- [Privacy policy](./docs/privacy-policy.md)
- [Security policy](./SECURITY.md)
- [Release notes](./docs/releases/)
- [MIT license](./LICENSE)

## Localization

The extension supports English (fallback), Korean, Japanese,
Simplified Chinese and Traditional Chinese. Chrome metadata follows Chrome's
language. The local `language` preference defaults to `auto` and supports a
manual override for extension-owned UI. The options page, display settings,
account actions and GitHub device sign-in flow support all five languages.
Changing language updates other open options tabs without restarting sign-in,
clearing repository input or repeating an account action. Repository diagnostics
reformat existing results and running status without another API request.
Reviewer labels, loading status, tooltips, accessible names, and access banners
update on open PR lists without fetching data again or restarting queued work.
Dismissed banners stay dismissed. GitHub content, reviewer identifiers, search
links, and the existing review-state colors, badges, and precedence are unchanged.
Product and GitHub App names remain unchanged. See the
[localization contract](./docs/adr/0006-bundled-localization-and-render-only-language.md)
for the manifest/UI boundary and shared APIs, and the
[five-language glossary and QA report](./docs/localization.md) for translation
coverage, packaged tests and native browser-language limitations.

Five-language [Chrome Web Store copy and screenshots](./docs/chrome-web-store-submission.md#per-locale-dashboard-checklist)
are maintained separately from packaged name/summary catalogs. Regenerate the
15 synthetic **TESTING** screenshots with `pnpm cws:assets` and validate copy,
links and image provenance with `pnpm verify:cws`. Existing English screenshots
and landing-page references retain their paths. These artifacts do not attest
production configuration, dashboard registration or publication.
