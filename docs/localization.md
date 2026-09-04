# Localization ownership and QA

The canonical copy is `public/_locales/{en,ko,ja,zh_CN,zh_TW}/messages.json`.
English defines meaning and the complete fallback contract. Each other locale is
reviewed against English separately, including Traditional Chinese; it is not
produced by converting Simplified Chinese characters. See
[ADR 0006](adr/0006-bundled-localization-and-render-only-language.md) for the
render-only lifecycle and [manual Chrome testing](manual-chrome-testing.md#localization-platform-verification)
for browser-language verification.

## Ownership and reviewed coverage

Issue #151 reviewed all 172 keys × five locales (860 entries), their descriptions,
placeholder declarations and their consumers. This is an implementation-owner
linguistic review, not a claim of external native-speaker certification. Independent
PR review is coordinated separately. Future additions must change the typed
`MessageArgs` contract and all five catalogs in the same PR.

| Namespace      | Keys per locale | Owner and context                                                                                                     |
| -------------- | --------------: | --------------------------------------------------------------------------------------------------------------------- |
| `extension_`   |               3 | Manifest name, description, toolbar title; Chrome owns selection                                                      |
| `options_`     |              45 | Options shell, account empty/error/installations/actions, display controls, permission/configuration guidance         |
| `language_`    |              11 | Selector autonyms, auto/help, save/live status and failure                                                            |
| `auth_`        |              21 | Device initiation/code/copy/URL/expiry/cancel, waiting/connected/denied/expired and structured failures               |
| `diagnostics_` |              56 | Input validation, matched account/coverage, all ten outcomes, endpoints and rate-limit evidence                       |
| `reviewers_`   |              14 | Loading/section/team, title/ARIA patterns, requested plus four completed states and four still-requested combinations |
| `banner_`      |              22 | Six access/failure kinds, configure/sign-in/reload/dismiss, usage and reset-time variants                             |

Owners of each surface maintain its namespace and consumer tests. The locale QA
owner maintains this glossary and checks cross-surface consistency. Store copy
and capture ownership is separate (#152); final store images must be recaptured
from the merged catalog corrections, not an earlier build.

The source audit included options `OptionsPage`, `AccountsList`, `AddAccountPanel`,
`DisplaySettingsPanel`, `LanguageSelector`, `DiagnosticsPanel`, diagnostic/auth
presentation helpers, reviewer DOM/view-model and access-banner formatter/DOM.
All visible/accessible prose in those surfaces uses message keys. Intentionally
literal content: the product lockup, `owner/name` syntax hint, `@login`, team
slugs, initials and technical evidence. The static options HTML title is an
English bootstrap fallback; the mounted app replaces title and `html.lang`.
Decorative images/badges have empty alt or `aria-hidden`; reviewer link names and
titles carry the selected-language review state. Host GitHub HTML language,
user content, API enums and links remain untouched.

## Five-language glossary

These are context-specific display terms, not translations of API enum values.

| Meaning                 | English                 | 한국어             | 日本語                   | 简体中文        | 繁體中文         |
| ----------------------- | ----------------------- | ------------------ | ------------------------ | --------------- | ---------------- |
| Review requested        | requested               | 리뷰 요청됨        | レビュー依頼中           | 已请求审阅      | 已要求審查       |
| Approved                | approved                | 승인됨             | 承認済み                 | 已批准          | 已核准           |
| Changes requested       | changes requested       | 변경 요청됨        | 変更要求済み             | 已请求更改      | 已要求變更       |
| Commented               | commented               | 의견 남김          | コメント済み             | 已评论          | 已留言           |
| Dismissed review        | dismissed               | 리뷰 무효화됨      | レビュー取り消し済み     | 审阅已撤销      | 審查已撤銷       |
| Still requested         | still requested         | 리뷰 요청 유지 중  | 引き続きレビュー依頼中   | 仍请求审阅      | 仍要求審查       |
| GitHub App installation | GitHub App installation | GitHub App 설치    | GitHub Appのインストール | GitHub App 安装 | GitHub App 安裝  |
| Repository              | repository              | 저장소             | リポジトリ               | 仓库            | 儲存庫           |
| Rate limit              | rate limit              | 요청 한도          | レート制限               | 速率限制        | 速率限制         |
| Username (GitHub login) | username                | 사용자 이름        | ユーザー名               | 用户名          | 使用者名稱       |
| Sign in                 | Sign in                 | 로그인             | ログイン                 | 登录            | 登入             |
| Token                   | token                   | 토큰               | トークン                 | 令牌            | 權杖             |
| Refresh installations   | Refresh installations   | 설치 정보 새로고침 | インストール情報を更新   | 刷新安装信息    | 重新整理安裝資訊 |

`DISMISSED` means an existing review was dismissed, not that a PR was rejected
or a notification was closed. `COMMENTED` does not override a prior non-comment
completed review. A requested reviewer can retain completed evidence; the refresh
badge needs a later `review_requested` event. Teams show requested teams, never
aggregate team approval. Unsubmitted `PENDING` reviews are excluded. Language
changes must not change any of those rules.

GitHub App installation is an account/organization installation granting access
to selected repositories; it is distinct from installing the Chrome extension.
Signing in does not grant access by itself. Local account removal does not revoke
GitHub authorization. Keep `GitHub Pulls Show Reviewers`, GitHub, GitHub App,
configured App names, `Pull requests: Read`, account/repository/team identifiers,
URLs, device codes, API states and endpoint/status/rate evidence literal.

Each message's `description` explains its surface. Placeholder arguments are
inert text; translators may reorder/repeat named placeholders in a whole sentence
but must retain names and positional contents. Use `$$` for a literal dollar.
Do not insert HTML. `options_open_only` filters reviewer-link destinations to
open PRs; it does not hide reviewer UI on closed PR rows. `options_names` displays
GitHub usernames, not personal display names.

## Language review decisions

| Locale | Reviewed result and corrections                                                                                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| en     | All 172 source meanings/contexts checked; username and open-PR link-filter controls made explicit. Technical values and review/auth semantics preserved.                                                                                                                                                   |
| ko     | All 172 translations compared with English. Matched-account labels distinguish the repository-selected account from any connected account; authorization management is distinct from review approval. Username/link-filter labels clarified.                                                               |
| ja     | All 172 translations compared with English. Standardized 非公開リポジトリ, corrected awkward private-access introduction and installation-owner guidance; completed changes-requested uses 変更要求済み. Dismissed remains レビュー取り消し済み; a shorter headline avoids awkward narrow-screen wrapping. |
| zh_CN  | All 172 translations compared with English. Metadata uses 受邀的审阅者; username uses 用户名 rather than 姓名. Retains 仓库/令牌/登录/访问/刷新/客户端; headings shortened after narrow-screen inspection.                                                                                                 |
| zh_TW  | All 172 translations independently compared with English. Uses 審查/核准/留言/儲存庫/權杖/登入/存取/重新整理/用戶端; review and API requests consistently use 要求 instead of mixed 請求. Username is 使用者名稱; headings shortened after narrow-screen inspection.                                       |

CJK headings also use balanced wrapping to avoid isolated final characters at
360px and desktop column widths. No terminology decision is deferred. The distinction between CN and TW is
intentional regional usage, not character conversion. Store descriptions were
also checked for glossary alignment; #152 owns the resulting copy edits and
final asset evidence. Landing page, privacy policy and developer-document
translation are outside scope.

## Completeness, fallback and package checks

`validateCatalogs` rejects invalid Chrome message shapes, unknown fields,
noncanonical key/placeholder names, empty text/context, divergent keys or
placeholder contracts, malformed dollars and noncontiguous positional arguments.
Chrome supports at most nine substitutions. `validateShippedCatalogs` additionally
requires exactly five locales and rejects verbatim untranslated English outside
an explicit invariant allowlist (brand, language autonyms, identifier patterns).
Runtime fallback is resilience only; shipped catalogs remain complete.

`pnpm verify:locales` checks emitted/source parity, strict catalogs, manifest
references, `default_locale: en`, preserved name and 75/132 character limits. The
packaged E2E gate runs this verifier too. Schema rules intentionally include
project constraints stricter than [Chrome's message format](https://developer.chrome.com/docs/extensions/how-to/ui/localization-message-formats).

Unit fixtures cover unsupported language → English, case/underscore/region
normalization, `zh-Hans`/`zh-Hant` script precedence, CN/SG and TW/HK/MO, and
source-language fallback using a separate deliberately incomplete **test** catalog.
No shipped catalog is made incomplete to exercise fallback.

## Executed evidence (2026-09-04)

Isolated Playwright Chromium with synthetic accounts/endpoints only. No shared
browser, actual sign-in, private API call, OS/browser user configuration change,
store mutation or production credential access. E2E builds use the fixture App
client ID/slug; this is packaged UI QA, not a production-config ZIP receipt.

- Options: five locales × 360/1280px, two tabs, long account/organization/repository
  identifiers, account refresh failure, retained diagnostic input and mixed
  HTTP 404/429 endpoint evidence. The three diagnostic requests and one failed
  installation refresh remain unchanged across language switches. Titles, HTML
  language, accessible selector names and translated error/live status checked.
- Reviewers/banner: five locales × 360/1280px, requested team, completed + still
  requested reviewer ARIA/title, unavailable banner/actions/dismissal, host text
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
logs. It checks Auto against `getUILanguage`, all 172 native messages against
`@@ui_locale`, and manifest/action/toolbar against the manifest's `current_locale`.
These are separate exact catalog comparisons, with all snapshots still required
to remain identical through manual override, reload and process restart.
Chromium's [manifest localization implementation](https://chromium.googlesource.com/chromium/src/+/master/extensions/common/extension_l10n_util.cc)
sets `current_locale` alongside localized description and action title. This
Chromium-specific field is used only by the test probe, not application code.
The Linux message/toolbar result remains pending until the corrected CI runs.

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
