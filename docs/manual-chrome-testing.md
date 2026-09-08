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
   requests a user verification code automatically. Complete the device flow
   with an account where the GitHub App is installed on
   **All repositories**.
5. Visit a private PR list in that account's namespace.
6. Confirm reviewer chips render for every row without an `app-uncovered` banner.

### Cancel and reopen GitHub sign-in

1. Open the options page, click **+ Add another account**, and note user verification code A.
2. While its token poll is pending, click **Cancel**. Wait for the cancellation
   acknowledgement and panel closure before reopening; note the new user
   verification code B. If commit was already admitted, wait for its actual
   completion instead of expecting a successful cancellation.
3. If A's delayed response arrives, confirm B stays visible with its own polling
   interval. A must not close B's panel, show an old error/expiry/denial, or start
   another account write. Complete B and confirm one normal account connection.
4. Close the options tab while initiation or account/installation discovery is
   pending. These phases do not show a Cancel button; closing the tab tests
   unmount cleanup. Abandoned work must not restart polling or publish completion.
   Switching display language during B must preserve its code and in-flight work.

Network timing is nondeterministic in live Chrome. The deterministic offline
counterpart in `tests/device-flow-controller.test.ts` defers every HTTP stage,
invokes programmatic cancellation even in phases without a Cancel button,
ignores abort deliberately, and covers late success/rejection, pending,
slow-down, denial, expiry, restart, and unmount. It also checks the commit
boundary: a successful cancel ACK forbids later commit; an already admitted
write returns committing/completed instead. A stale callback cannot close a
newer panel. Cancellation never rolls back or deletes a saved account.

### Sign-in clipboard, keyboard, and status feedback

Use an isolated Chrome profile and synthetic device-flow responses for this
check. Do not complete a real GitHub authorization or change an account,
permission, or clipboard setting.

1. With the keyboard, focus **+ Add another account** and activate it. Focus
   moves to the programmatically focusable sign-in panel once; waiting, polling,
   a slow-down response, and changing the extension language must not move it
   again. Confirm **Copy**, the authorization link, **Cancel**, **Close**, and
   retry controls remain keyboard-operable.
2. Stub a successful Clipboard API write and activate **Copy**. It is disabled
   only while that write is pending, then an atomic polite status says that the
   code was copied. Stub a rejected write and an unavailable Clipboard API in
   separate runs; each must instead say to select and copy manually. The device
   code remains selectable and the authorization link still works. No raw
   browser-error text appears.
3. Begin a deferred copy for code A, replace it with code B, then complete A.
   A's result must not alter B's feedback. A new copy of B can proceed, and its
   outcome is the only one shown.
4. Focus **Cancel** or **Close** and activate it. Once the panel disappears,
   focus returns to the control that opened it, or to **+ Add another account**
   when that control no longer exists. Complete a synthetic successful sign-in
   once with focus inside the panel and once after moving focus to another
   control: only the former returns focus. In both cases the accounts section
   has one concise localized connected status after the panel closes.
5. VoiceOver-specific spoken-output testing is out of scope. Do not add a
   VoiceOver pass/fail gate for these states. Keep the ordinary web
   accessibility checks above: keyboard operation, focus recovery, localized
   visible status feedback, and the existing HTML/ARIA semantics remain part
   of this manual check.

### Background credential boundary and worker recovery

Use an isolated profile and synthetic credentials. Do not print auth records,
request headers, OAuth bodies or device-code secrets from a real profile.
Options should display only the user verification code/link and account identity.

1. Build with `pnpm test:e2e:build` and run:
   `pnpm exec playwright test tests/e2e/token-free-boundary.spec.ts --project=default`.
   This loads the production MV3 bundle in isolated Chromium profiles, mocks
   OAuth/API responses, inspects actual runtime replies/port events and records
   only request paths plus service-worker provenance. Both options documents
   must have zero raw storage reads/listeners and no secret fields/sentinels.
2. In the GitHub fixture's **extension content isolated world**, confirm
   `chrome.storage.local.get(null)` and a harmless test write both reject after
   initialization. Page-world access is a different question and is not this
   check. Content snapshot and repository operations must still work; content
   login/removal/preferences/diagnostics requests must be rejected.
3. Start sign-in, receive a waiting code and a synthetic `slow_down`, then stop
   the actual worker using CDP `ServiceWorker.stopWorker`. Observe its stopped
   state before the next options tick. Keep worker DevTools closed so it does
   not keep the worker alive. Confirm the next tick wakes a worker, retains the
   same flow ID/deadline/slowdown interval and connects one account. The packaged
   test records these observations; service-object recreation alone is not
   worker lifecycle evidence.
4. In the same profile, close/reopen the browser during an unfinished flow.
   The old session must request a new code explicitly. Already connected
   accounts and display/language preferences remain saved. An interrupted OAuth
   HTTP operation similarly offers a new code instead of replaying an uncertain
   exchange. Unit tests separately cover pending commit recovery receipts.
5. The packaged upgrade cases seed a tiny synthetic v3/v4 predecessor extension,
   close Chrome, replace its unpacked files and register the new bundle through
   Chrome's `Extensions.loadUnpacked` operation without uninstalling or clearing
   the same profile. Assert unchanged extension ID, credentials, existing v4
   generation and non-default Korean/display preferences, plus renewed content
   storage denial. This is synthetic old-profile coverage, not a signed CWS
   automatic-update test or a run of the historical production ZIP.
6. In a headed isolated Chrome/Chrome for Testing window, operate the real UI:
   remove an invalidated account, invoke reauthentication, use keyboard focus and
   Enter/Space on Remove, and remove the final account to check the empty state.
   Switch languages/display settings in two options tabs and inspect reviewer
   names/badges/link qualifiers on the same fixture page. Count OAuth/reviewer
   requests separately from images and ordinary polling. Use supported native UI
   controls for this smoke check; a headed Playwright script alone is automated
   coverage, not manual UI evidence.

Record performer, date/time, OS/browser/tool versions, source SHA and bundle
hash, procedures, expected/observed results and screenshot/log paths. Distinguish
packaged automation, native UI manipulation and any optional live GitHub checks.
If a required environment is unavailable, name the exact missing check and
error instead of marking it passed. See
[ADR 0008](./adr/0008-background-credentials-and-ui-capabilities.md) for the
application-enforced options boundary and browser-enforced content restriction.

### Signed-in, selected-repos installation

1. Install the GitHub App on an organization with only two selected
   repositories.
2. Complete the device flow with the owning user.
3. Visit one of the two selected repositories' PR list; confirm reviewer chips
   render.
4. Visit a third repository in that org; confirm an empty reviewer slot per row
   and a banner prompting to add access.
5. In the options page, click **Refresh installations**, then run
   **Check matched account** for one selected repository. Confirm diagnostics
   reports the matched account result. For unusually large selected
   installations where GitHub pagination exceeds the local ceiling, diagnostics
   should show `Installation coverage` as
   `Maybe covered - local snapshot truncated` alongside the endpoint result.

Authenticated pagination-target rejection is covered by `tests/auth.test.ts`
because a normal Chrome session cannot inject GitHub's `Link` response header.
Those tests verify that malformed or off-endpoint targets receive no second
OAuth-authenticated request and leave both installation-list and
selected-repository results truncated.

### Multi-account repository fallback

Use an isolated profile with a fresh local build, synthetic accounts and mocked
GitHub HTTP. Do not use signed-in GitHub credentials or consume real API quota.
`pnpm test:e2e:build`, `pnpm verify:locales`, and
`pnpm exec playwright test --project=default --grep 'multi-account repository fallback'`
exercise the production packaged service and content boundary. Automated
Playwright checks and native UI observations must be recorded separately.

1. Seed active A before B, both with the same organization `all` installation.
   Return 403 or 404 for A's pull-list metadata and valid metadata/reviews for B.
   Open the PR fixture and verify reviewer chips appear without an intermediate
   access banner. Check safe request provenance: one A probe, one B probe and B
   reviews. No real credential belongs in the fixture or evidence.
2. In options, run matched diagnostics for that repository. It should identify
   B. Repeat with an empty successful pull list and confirm the no-pulls result
   is understandable. A missing individual PR must not imply the repository is
   inaccessible. The explicit no-token button must send anonymous HTTP only.
3. Change all five languages and the three display settings during a deferred
   discovery and after success/exhaustion. Existing chips, running/result copy
   and guidance rerender while candidate admissions and request counts stay put.
4. Repeat with authenticated 429, exhausted/secondary 403, unresolved 401,
   mixed 404+429/401, network/schema/server failure and cancellation. Confirm no
   next candidate is sent. Same-account 401 recovery may precede a later 404
   and B success; token rotation itself must not open another wave.
5. Preserve the document and session storage while terminating the actual MV3
   worker. Confirm recorded denial can resume with an unattempted candidate,
   stop/exhaustion cannot restart, and an admitted unknown dispatch requires an
   explicit new generation. A normal port disconnect is insufficient to retire
   the record. Replacing the document/closing its tab removes obsolete records
   and cancels active work without accepting late results.
6. Check more than four rows, queued row removal, stale-chip recovery and a
   remaining PR failure after other rows succeed. The FIFO cap stays four and
   the aggregate banner reflects only current final outcomes. Navigation,
   explicit refresh and account access changes may revalidate; ordinary row
   mutations, TTL expiry and locale changes must not reset failed admissions.

Record source SHA, package hashes, profile/browser/OS, mocked schedules, request
provenance and screenshots. These checks establish fixture behavior, not a live
GitHub permission test.

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
5. In a separate run of this invalidated setup, use Tab then Enter or Space on
   **Remove** to discard the account locally without starting sign-in or
   contacting GitHub. Confirm the normal empty state appears if it was the last
   account.
6. For the reauthentication path, click **Sign in again** and complete the
   device flow with the same GitHub account. Confirm the invalidated card is
   replaced in place — there should
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

### Overlapping recovery and account changes

Use fixture credentials and deferred HTTP in the automated auth regression suite
for exact race ordering; a live credential race is not required. For a manual
packaged-extension smoke check, verify that reviewer refresh, diagnostics, and
manual installation refresh retain the same sign-in/error behavior. Reconnect
and remove an account through options and confirm there is one retained card
per GitHub login and removed cards stay absent. Switching any of the five
supported languages during a refresh must only reformat the existing UI.

The deterministic `auth-generation` and `accounts.registry-concurrency` tests
cover delayed 401s after rotation, obsolete retry invalidation, reauthentication
or removal during refresh, and concurrent sign-in/registry repair. Inspect only
account IDs, revision identities, result codes and request counts; never copy
credentials into logs or test reports.

### Expired access token with invalid refresh token

1. Starting from the previous scenario, also corrupt
   `account:auth:<id>.refreshToken`.
2. Reload the private PR list.
3. Confirm the account is marked invalidated with
   `invalidatedReason: "refresh_failed"` and the UI prompts for sign-in again.
4. Use **Remove** with the keyboard (Tab, then Enter or Space) to discard the
   invalidated local account without starting sign-in or contacting GitHub.
   Confirm the usual empty state appears when it was the last account.

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

## Options language and account continuity

For a reproducible actual v1.15.0-profile upgrade, use the committed standalone
probe and commands in the [v1.16.0 readiness handoff](releases/v1.16.0-readiness.md#real-old-profile-upgrade).
It runs the published old ZIP before replacing the same unpacked path/profile,
and compares raw account/auth/display records across browser-process restarts.
This is not a signed Web Store automatic-update test.

Use controlled fixture accounts; do not expose live tokens in screenshots.

1. Open two options tabs. Select each of English, 한국어, 日本語, 简体中文 and
   繁體中文 in the first tab. Verify the shell, accounts and display settings in
   both tabs update, the title/HTML language changes, and the selection persists
   after reload. Auto follows Chrome's language (unsupported locales use English).
   Chrome toolbar metadata continues to follow Chrome independently.
2. Begin sign-in and change language while requesting a device code, waiting for
   authorization, and loading installations. Check that the same code and URL
   remain, polling does not restart, and cancellation still works. Expiry uses
   the chosen locale in your existing timezone. Verify expired, denied, connected
   and known/unknown failure guidance; technical codes and identifiers stay literal.
3. Enter a diagnostic repository, start an account refresh, and switch language.
   Input and accounts stay in place and the refresh runs once. Repeat for a
   pending display save and a failed remove/save. Visible statuses change language
   without restarting actions. Diagnostic prose updates from retained structured evidence without rerunning the check.
4. Simulate a local language save rejection with test fixtures. Verify an
   accessible failure message, an enabled selector, and the previous saved
   language retained. Then save successfully and verify both tabs recover.
5. Check 360px and desktop widths with a long GitHub App name and long account/
   repository identifiers. No horizontal page overflow or hidden action buttons;
   labels, keyboard focus and live status announcements remain usable.

## Enabled button contrast and keyboard focus

Use the built options page with synthetic account fixtures. Inspect an enabled
primary button such as **Add another account**, **Check matched account**, or
**Sign in again** in its default, hovered, keyboard-focused, and active states.
Chrome DevTools should report a final rendered background of `#1f7a30` in the
default state and `#238636` on hover, with white text at or above a 4.5:1
contrast ratio. Confirm the focus outline remains visibly distinct and that
disabled controls remain visibly disabled; do not count disabled controls as
enabled contrast failures.

Repeat the check for **Sign in again** inside an invalidated account card. The
card should retain its warning treatment through its border without applying
ancestor opacity, so the enabled button and its focus indicator retain the same
contrast after compositing. Repeat at desktop and 360px/narrow widths in
English, 한국어, 日本語, 简体中文, and 繁體中文. Record the computed foreground,
background, every ancestor opacity, viewport, locale, and any screenshot or
console evidence in the task handoff.

## Localization platform verification

See [localization ownership, glossary and executed evidence](localization.md).
Use isolated test profiles and synthetic accounts; leave the shared browser and
OS language unchanged during agent QA.

1. Build with `pnpm test:e2e:build`, then run the three localization specs listed
   in `docs/localization.md`. Their first launch waits for the install-owned
   options page (#159); do not race it with another options navigation.
2. In extension-page DevTools, observe `chrome.i18n.getUILanguage()` and
   `chrome.i18n.getMessage('@@ui_locale')` separately. Also record
   `chrome.runtime.getManifest().description`,
   `await chrome.action.getTitle({})`, launch flags, platform and any Playwright
   locale override, including runner defaults. Playwright Test defaults to
   `en-US` and injects it into persistent contexts even when `locale` is omitted.
   The native probe runs in a separate Node process to avoid that hook.
   `browser.i18n` in the extension uses the same native API.
   `navigator.language`, a Playwright locale, or a `--lang` flag alone cannot
   establish Chrome's extension UI language.
3. With **Auto**, confirm the options `html.lang` and prose match the actual
   `getUILanguage()` result through ADR 0006's resolver. Unsupported languages
   use English; script/region alias behavior has unit coverage. To claim actual
   non-English Auto selection, first observe a non-English API return on a
   separately authorized supported browser/OS configuration.
4. Select each supported manual language. Confirm options/accounts/device auth,
   diagnostic status/evidence, reviewer link ARIA/title and banner actions use it.
   The GitHub page language and identifiers must remain unchanged. Chrome-owned
   metadata and toolbar text must remain at their independently observed locale.
5. Save Traditional Chinese, reload the options tab, close the entire isolated
   Chromium process, and reopen the **same profile**. Verify the selection and
   UI language persist; select Auto and verify the actual native language returns.
6. Switch language in a second tab during a held device-code request, held token
   poll and diagnostic requests. Preserve code, authorization URL, input, request
   state and banner dismissal. Count data/auth requests separately from avatars
   and ordinary time-driven polling. No request may be caused by language alone.
7. Inspect 360px and desktop screenshots for CJK glyphs, wrapping, long identifiers,
   clipping and visible keyboard focus. Check accessible names/live statuses in
   the selected language. Actual screen-reader pronunciation still needs manual
   assistive-technology testing; ARIA assertions do not establish pronunciation.

The probe records initial observations before asserting, so failed checks also
retain raw evidence. It validates Auto against `getUILanguage`, native message
text and manifest/action/toolbar against Chromium's `manifest.current_locale`
(which must be an exact shipped locale). The manifest and renderer messages use
the same browser-side bundle loader. `@@ui_locale` is retained separately as a
process-locale observation, not a message-catalog selector. Linux
CI run `33855860843` observed a Korean manifest with an English-resolved
`@@ui_locale` and stopped before the remaining assertions. Use the corrected run's raw evidence for Linux message/toolbar and restart
results. Restart requests `runtime.openOptionsPage()` and waits for the actual
options UI to avoid competing direct navigation.

Executed on macOS Chromium 147 on 2026-09-04: the standalone Node subprocess
with headless Chromium, `--lang=ko` and no runner-injected locale observed
`getUILanguage()=ko`, `@@ui_locale=ko`, `navigator.language=ko-KR`, and Korean
manifest/toolbar text. Auto rendered Korean; the manual Traditional Chinese
selection left metadata unchanged and survived reload and process restart.
Returning to Auto restored Korean. This covers the observed configuration,
not every OS/UI language or an installed user Chrome browser.

The original in-runner `en-US` result was caused by Playwright Test's default
locale injection and must not be reused as native platform evidence. Reproduce
the corrected probe directly after the fixture build with:

```bash
node --experimental-strip-types tests/helpers/native-locale-probe.ts /tmp/native-language.json
```
