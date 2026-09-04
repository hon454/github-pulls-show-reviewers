# Chrome Web Store Submission Packet

This file turns the store notes into concrete submission materials for the current MVP.
Use the [canonical agent runbook](./chrome-web-store-agent-runbook.md) for
authorized dashboard execution, saved-content evidence and resumption. Manual
listing steps are agent-executable within existing session authorization; saving
copy does not authorize review submission or tagging.

## Listing fields

The canonical name is `GitHub Pulls Show Reviewers` in every locale. Packaged
name and summary come from `extension_name.message` and
`extension_description.message` in `public/_locales/<locale>/messages.json`.
The reviewed locale files link directly to that summary; use its current value
verbatim, without an independently edited duplicate. `pnpm verify:cws` prints
all current values and validates the 75/132 character limits and identity.

Category: `Developer Tools`. English is the default/fallback language; prepare
all five supported locale variants below. The `Detailed description` section
between the comments in each locale file is the text to paste (omit Markdown
headings, comments, screenshot inventory and maintenance notes).

## Per-locale dashboard checklist

These are listing-preparation instructions. Actual registration and publication
evidence belongs in the release tracking issue, using the existing
[canonical agent runbook](./chrome-web-store-agent-runbook.md) and the
[staged action reference](./cws-agent-handoff.md).
The unchecked boxes below are a reusable checklist, not claims of completed writes.

| Dashboard locale | Reviewed description and catalog link | Matching screenshots | Saved/reopened evidence |
| --- | --- | --- | --- |
| English (`en`) | [English](./chrome-web-store-locales/en.md) | [English root](./chrome-web-store-assets/) | [ ] |
| 한국어 (`ko`) | [한국어](./chrome-web-store-locales/ko.md) | [ko/](./chrome-web-store-assets/ko/) | [ ] |
| 日本語 (`ja`) | [日本語](./chrome-web-store-locales/ja.md) | [ja/](./chrome-web-store-assets/ja/) | [ ] |
| 简体中文 (`zh_CN`) | [简体中文](./chrome-web-store-locales/zh_CN.md) | [zh_CN/](./chrome-web-store-assets/zh_CN/) | [ ] |
| 繁體中文 (`zh_TW`) | [繁體中文](./chrome-web-store-locales/zh_TW.md) | [zh_TW/](./chrome-web-store-assets/zh_TW/) | [ ] |

For each row:

- [ ] Confirm the checked package contains all five `_locales` catalogs and
  `default_locale: en`; run `pnpm verify:locales` against that package's extracted
  output. Confirm the unchanged name and catalog summary match the displayed
  metadata. Adding catalogs does not populate detailed descriptions.
- [ ] Select the matching language in the Store listing language dropdown.
- [ ] Preserve scoped before-state. Paste that file's detailed description;
  retain matching images, replace identified previous-release images within
  the assigned listing scope, and add missing screenshots in `01`, `02`, `03`
  order. No repeated approval is needed for expected replacement; resolve
  unidentifiable or out-of-scope images before removal.
- [ ] Check the preview for the right language, readable CJK text and no clipping.
  Confirm reviewer-only features, no-token public use, private GitHub App access,
  multiple accounts and `Pull requests: Read` agree across every language.
- [ ] Save, navigate away and back, compare the full persisted text and all
  three ordered previews. Record copy/image hashes, UTC and scoped evidence
  in the release issue per the canonical runbook. A save toast is insufficient.

Chrome chooses packaged metadata independently of the extension's saved manual
UI language. That selector does not choose or update a dashboard listing locale.
GitHub content and its external authorization page are not translated by the
extension. Landing, privacy and developer-document links remain English.

Small and marquee promotional tiles are global fields and cannot be localized;
there are no per-locale tile-upload steps. The inventories describe the scenes
for review and do not invent a separate dashboard caption field. See
[Chrome's listing localization guidance](https://developer.chrome.com/docs/webstore/cws-dashboard-listing#localize_your_listing).

## Screenshot inventory

Every locale uses three `1280x800` 24-bit RGB PNGs without alpha, in this order:

1. `01-pr-list-before-after.png` — default GitHub PR list and reviewer-enhanced list.
2. `02-pr-list-avatar-state-showcase.png` — requested outlines, team chips and completed review badges.
3. `03-options-repository-check.png` — display settings and a no-token public repository result.

English stays at `docs/chrome-web-store-assets/` so existing landing references
remain valid. The other twelve images live in `ko/`, `ja/`, `zh_CN/`, and `zh_TW/`.
The PR titles, usernames, team slugs and avatar images are synthetic fixtures;
GitHub/user content remains unchanged across locales. No real accounts, private
data or live dummy PRs are used.

## Capture maintenance

After canonical catalog/glossary corrections have merged, update the five
listing files and regenerate from the integrated source:

```bash
pnpm cws:assets
pnpm verify:locales
pnpm verify:cws
```

`pnpm cws:assets` retains the separate Playwright capture project; ordinary E2E
runs do not rewrite listing assets. It builds with `TESTING_CLIENT_ID`,
`test-app`, and `GitHub Pulls Show Reviewers (testing)`. These are synthetic
**TESTING** captures, not production-config artifacts or private-access proof.
No account is connected. Captures use isolated disposable Chromium profiles and
block external HTTPS except explicit fixture responses.

Each locale is selected and persisted before capture. Fixture spacing frames all
eight PR rows; source/user text is unchanged. The options image composes native
language, display and completed-diagnostics section screenshots side by side,
without changing their text or controls, to avoid cutting off settings at scroll
boundaries. Extension labels are
checked against its catalog, while the before/after composition captions come
from `capture-before` / `capture-after` comments in its reviewed listing file.
Fonts and images finish loading, focus/hover is cleared, motion is disabled,
and scale, timezone and synthetic host locale are fixed. The generated
[capture manifest](./chrome-web-store-assets/capture-manifest.json) records source
and image hashes, browser version, platform and rendering settings. It contains
no credentials. Byte-for-byte reproducibility requires the same Chromium,
platform and installed system fonts; cross-platform font rasterization can differ.
Run the command twice and compare image hashes on the capture host when validating
reproducibility. Review and commit the final images and manifest together.

`pnpm verify:cws` validates the five source-linked names/summaries, ordered links,
15 PNG headers/dimensions/RGB format, and source/image hashes. It does not replace
linguistic or visual review. Inspect **each of the 15 images**, including CJK
glyphs, line wraps, cropping, labels, focus rings, and caption/content overlap.
Recheck copy against the [shared glossary](./localization.md) and
[localization contract](./adr/0006-bundled-localization-and-render-only-language.md).
Document exact source, commands, all fifteen visual verdicts and limitations in
the review/release handoff. Preparing artifacts alone does not attest dashboard
registration or publication.

## Current privacy practices

Use the current shipped behavior, not aspirational behavior.

Single purpose:
`Show requested reviewers, requested teams, and completed review state inside GitHub pull request list pages.`

Permission justification:

- `storage`: stores locally the GitHub App accounts (user-to-server access token, refresh token, and token-expiry timestamps per account) so the user can access private repositories. It also stores the review-chip display preferences (`showStateBadge`, `showReviewerName`, and `openPullsOnly`) and UI language preference (`language`, default `auto`) under the local `preferences` key.
- `alarms`: schedules a recurring 15-minute background task that refreshes GitHub App access tokens ahead of expiry. Without this, every eight-hour token lifetime would force the user to sign in again even while actively using the extension, and reviewer lookups on private repositories would stall until the next sign-in.
- `https://github.com/*`: reads the current GitHub pull request list page to find repository context and render reviewer chips inline.
- `https://api.github.com/*`: fetches requested reviewers, requested teams, and review history from GitHub's REST API. Requests originate from the extension's background service worker; the access token never enters the content-script execution context.

Remote code:
`No, this extension does not execute remote code.`

Conservative data usage:

- Authentication information: `Yes`
  Reason: the user may sign in with GitHub via the GitHub App, and the resulting user-to-server token is stored locally for private repository access.
- Website content: `Yes`
  Reason: the extension reads repository and pull request context from GitHub pages and renders reviewer metadata into the page.
- Browsing activity: `Yes`
  Reason: the extension detects when the user is on a GitHub repository pull request list page in order to activate.
- Personal communications, health information, financial/payment information, location, web history outside GitHub, and advertising identifiers: `No`

Certification:

- Data is used only for the extension's reviewer-visibility feature.
- Data is not sold.
- Data is not used for creditworthiness or lending decisions.
- Data is not used or transferred for unrelated advertising or marketing.

Sharing:

- Requests needed for reviewer lookups go directly to GitHub.
- No extension-operated backend receives user data.
- No data is shared with advertisers or data brokers.

Privacy policy URL:
`https://github.com/hon454/github-pulls-show-reviewers/blob/main/docs/privacy-policy.md`

Earlier submission preparation tracked the need to host
[privacy-policy.md](./privacy-policy.md) at a stable public URL. The published
Chrome Web Store listing now uses the GitHub-hosted policy URL above. Keep that
link and the privacy fields aligned with the shipped behavior.

## Release and upload checklist

For a first localized listing release, use the
[canonical agent runbook](./chrome-web-store-agent-runbook.md): checked `upload-only`, register
the five approved locale descriptions/screenshots, then `submit-existing` with
fresh dashboard evidence tied to the immutable upload receipt. Neither staging
action creates a GitHub Release. Do not execute the normal tag-first step below
until the localized handoff is complete; the later tag must point to the same
reviewed source and reuses its verified artifact without another CWS submission.

1. Run `pnpm preflight:release` in an environment with `WXT_GITHUB_APP_CLIENT_ID`, `WXT_GITHUB_APP_SLUG`, and `WXT_GITHUB_APP_NAME` populated. For local release builds, `pnpm build:release` and `pnpm zip:release` load these from GitHub Actions repository variables through `gh` and run the same preflight.
2. Run `pnpm verify:release`.
3. Run `pnpm cws:assets` if the submission screenshots need to reflect UI changes.
4. Run `pnpm zip:release` only after the checks above pass. Do not upload a
   package created by plain `pnpm zip`; the release script loads the maintainer
   GitHub App identifiers and verifies the final zip before submission.
5. Run the [version-alignment
   preflight](./chrome-web-store.md#version-alignment-preflight) and
   confirm `package.json`, the packaged zip filename, the `v<version>`
   Git tag, and the `docs/releases/v<version>.md` note all use the same
   bare `<version>` value.
6. Open the packaged extension's options page once before upload and
   confirm it never renders as a blank white screen. A missing GitHub App
   build config must surface the explicit configuration warning instead.
7. For an ordinary new version, push the `v<version>` tag. The release workflow uploads
   `.output/*-chrome.zip` through the Chrome Web Store API v2 and submits it
   for automatic publication after approval.
8. Confirm the release workflow and dashboard package version both read the
   same bare `<version>`.
9. Listing descriptions/screenshots must already be saved and reopened before
   submission when this release changes them; use the staged path above. An
   ordinary tag-first release assumes the existing listing is ready.
10. Verify catalog-sourced name/summary and the privacy policy URL above.
11. Inspect privacy answers against shipped permissions and network behavior.
    Edit only if that scope is authorized; localized listing authority alone
    does not cover privacy, distribution, visibility or pricing changes.
12. For a credential-only rehearsal, run the reviewed release workflow with
    `chrome_web_store: dry-run`; it performs no build, package upload, review
    submission, or GitHub Release creation. The default `skip` never mutates CWS,
    including a dispatch against a tag. A tag-scoped skip may refresh the GitHub
    Release artifact. These guarantees require the updated workflow: do not
    dispatch legacy control refs such as `--ref v1.15.0`. Select updated `main`
    or a reviewed branch and pass old package tags via the separate `tag` input
    as shown in the [handoff](./cws-agent-handoff.md).
13. After approval and automatic publication, confirm the Git tag, GitHub
    Release, release note, and published store version still reference the
    same bare `<version>` value.

## Current package target

Expected package path after `pnpm zip:release`:

```text
.output/github-pulls-show-reviewers-1.16.0-chrome.zip
```

See the [v1.16.0 readiness handoff](./releases/v1.16.0-readiness.md) for local
package/upgrade/language evidence and the exact integrated rerun. This target
does not attest an uploaded draft, saved listings or publication.

## Localization boundary

The extension bundles English, Korean, Japanese, Simplified Chinese and
Traditional Chinese catalogs. Manifest metadata follows Chrome's language;
a manual extension UI language preference cannot override Chrome-owned metadata.
Names of the product and GitHub App stay unchanged. No remote translation
service, new permission, or additional data collection is introduced. The five reviewed listing files and screenshots are preparation materials;
saved dashboard entries and publication require separate release evidence.
