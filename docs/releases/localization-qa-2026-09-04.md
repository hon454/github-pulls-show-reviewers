# Localization QA evidence (2026-09-04)

Moved from [localization.md](../localization.md) by #257. This is the dated
execution record for the #151 five-language review; the current contract,
glossary and checks live in `localization.md`. Counts below (172 messages,
744 unit tests, 22 E2E tests) describe the tree at that time.

Isolated Playwright Chromium with synthetic accounts/endpoints only. No shared
browser, actual sign-in, private API call, OS/browser user configuration change,
store mutation or production credential access. E2E builds use the fixture App
client ID/slug; this is packaged UI QA, not a production-config ZIP receipt.

- Options: five locales × 360/1280px, two tabs, long account/organization/repository
  identifiers, account refresh failure, retained diagnostic input and mixed
  HTTP 404/429 endpoint evidence. The three diagnostic requests and one failed
  installation refresh remain unchanged across language switches. Titles, HTML
  language, accessible selector names and translated error/live status checked.
- Reviewers/banner: five locales × 360/1280px, requested team, confirmed and
  unverified completed + still-requested reviewer ARIA/title/badge behavior,
  unavailable banner/actions/dismissal, host text
  untouched. FIFO 42…49, peak four, metadata one/reviews eight/events seven;
  language switches and 800 extension append/remove pairs add no data requests. Avatar
  image requests are separate and are not claimed to be zero network activity.
- Device auth: switch from a second options tab through five locales while code
  initiation is held, then while the one token poll is held. Same code/URL/input,
  translated live status/copy/cancel, keyboard Tab focus and 360/1280px layout.
  Exactly one initiation and one poll; cancel plus advancing the controlled
  clock adds no requests. The paused clock isolates ordinary polling from
  language-triggered requests; it does not assert that normal auth never polls.
- Native platform: the E2E test starts `tests/helpers/native-locale-probe.ts` in
  a separate Node process, so Playwright Test's automatic `locale=en-US` fixture
  cannot modify its persistent context. With explicit headless Chromium and
  `--lang=ko` on macOS, the extension's `chrome.i18n.getUILanguage()` returned
  `ko`, `@@ui_locale` returned `ko`, and `navigator.language` was `ko-KR`.
  Auto UI rendered Korean. All 172 Chrome messages/interpolations matched the
  Korean catalog. Manual `zh_TW` changed only extension UI and persisted through
  tab reload **and browser process restart**; returning to Auto restored Korean.
  Evidence records native/manifest/toolbar snapshots before and after override,
  after reload and after restart, along with launch args and execution mode.

Linux CI run `33855860843` exposed a separate test assumption: the manifest
returned Korean text while `@@ui_locale` resolved to English. That failed run
stopped before checking message text or toolbar, so it does not establish their
locale. The probe now records raw API values and the selected `LANG`, `LANGUAGE`,
`LC_ALL`, and `LC_MESSAGES` environment values before assertions, including in CI
logs. It checks Auto against `getUILanguage`. Manifest/action/toolbar and all 172
native messages are compared exactly with the catalog named by the manifest's
`current_locale`, which must be an exact shipped locale (no inferred fallback).
`@@ui_locale` is retained as a separate process-locale observation. All raw native
messages are collected before assertions; snapshots must remain identical through
manual override, reload and process restart.
Chromium 147's [manifest localization](https://chromium.googlesource.com/chromium/src/+/147.0.7727.15/extensions/common/extension_l10n_util.cc)
and [renderer message loading](https://chromium.googlesource.com/chromium/src/+/147.0.7727.15/extensions/browser/l10n_file_util.cc)
use the same browser-side message-bundle loader with preferred-locale precedence.
Its [predefined message implementation](https://chromium.googlesource.com/chromium/src/+/147.0.7727.15/extensions/common/message_bundle.cc)
sets `@@ui_locale` from the process locale, which need not select that bundle.
The Chromium-specific `current_locale` field is used only by the test probe,
not application code.
Read each platform result from its recorded observations; the macOS result does
not establish Linux outcomes. On process restart the probe requests
`runtime.openOptionsPage()` and waits for the actual options UI. This avoids a
direct `goto` competing with Chrome-owned navigation, observed once during
independent review. It does not assume which browser lifecycle event opened it.

Independent review caught that the original in-runner probe omitted an explicit
locale but still received Playwright Test 1.59.1's **default `en-US` injection**.
Its en-US UI / Korean metadata split was an emulated-context observation, not a
macOS native-language limitation. That evidence is superseded by the standalone
subprocess result above. Merely omitting `locale` in a test runner does not prove
that locale emulation is absent. The other manual-language layout/auth fixtures
continue to use the runner's default locale and do not claim native detection.

The standalone result proves observed Korean Auto selection and metadata/manual
independence in this Chromium configuration. It does not cover all five OS/UI
language configurations or a user's installed Chrome browser. Actual screen-reader
pronunciation remains manual. No OS or shared browser settings were changed.
Unsupported-language and script/region mapping use unit fixtures; no flag or
navigator value substitutes for the observed native API. Review-state/error
permutations remain covered by focused unit tests, and the full English
scheduler/DOM suite and separate live GitHub canary are unchanged.

Reproduce:

```bash
pnpm test:e2e:build
pnpm exec playwright test tests/e2e/locale-platform.spec.ts tests/e2e/options-localization.spec.ts tests/e2e/reviewer-localization.spec.ts --project=default --workers=1 --reporter=json > /tmp/localization-report.json
pnpm verify:release
```

Screenshots are written under `test-results/` (`options-`, `reviewers-`, and
`device-<locale>-<width>.png`). JSON reporter attachments include native language,
auth request counts and FIFO totals. Retain that report and images before another
Playwright run replaces test results. Final validation/visual verdict is recorded
in the PR; the coordinator retains exact-head evidence through merge.

Validation result: `pnpm verify:release` passed 744 unit tests (42 files),
94.23% line / 89.91% branch coverage, and all 22 packaged E2E tests without retries.
After the final CJK headline/wrapping polish and expanded observation payload,
fresh build, lint, typecheck, 49 focused i18n tests and all five packaged locale
checks passed again (zero skipped/flaky tests). Coverage thresholds and the live
canary were not changed.

| Locale | Visual inspection at 360px and 1280px                                                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| en     | Options/account failure, diagnostic endpoints, device controls/focus and PR/banner readable; long identifiers wrap.                            |
| ko     | Same surfaces checked; Korean glyphs, matched-account labels and balanced headings readable; actions/focus visible.                            |
| ja     | Same surfaces checked; Japanese glyphs and revised headings readable, no isolated final headline character; device/diagnostic actions visible. |
| zh_CN  | Same surfaces checked; Simplified glyphs/terms distinct, shortened balanced headings and endpoint wrapping readable.                           |
| zh_TW  | Same surfaces checked; Traditional glyphs/region-specific terms distinct, balanced headings and translated device actions readable.            |

After the independent P2 correction, the isolated native subprocess and the
retained auth checks passed again, along with lint/typecheck, all five packaged
locale checks and all 22 E2E tests (no retries). The updated report supersedes the
original in-runner native-language claim.

Thirty reproducible screenshots were retained with the final JSON observation
report. These are minimal regression fixtures, not store marketing screenshots.
