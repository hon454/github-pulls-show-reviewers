# Localization ownership and QA

The canonical extension UI copy is `public/_locales/{en,ko,ja,zh_CN,zh_TW}/messages.json`.
English defines meaning and the complete fallback contract. Each other locale is
reviewed against English separately, including Traditional Chinese; it is not
produced by converting Simplified Chinese characters. See
[ADR 0006](adr/0006-bundled-localization-and-render-only-language.md) for the
render-only lifecycle and [manual Chrome testing](manual-chrome-testing.md#localization-platform-verification)
for browser-language verification.

README translations use the same five-language glossary below. English
`README.md` is their source of truth; the
[Documentation Guideline](guidelines/documentation-guideline.md) defines their
file mapping, synchronization rules, and review checklist. README translations
are maintained separately from extension catalogs and store listings.

## Ownership and reviewed coverage

Issue #151 reviewed the original 172 keys × five locales (860 entries), their descriptions,
placeholder declarations and their consumers. This is an implementation-owner
linguistic review, not a claim of external native-speaker certification. Independent
PR review is coordinated separately. Future additions must change the typed
`MessageArgs` contract and all five catalogs in the same PR.

| Namespace      | Keys per locale | Owner and context                                                                                                                                                        |
| -------------- | --------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extension_`   |               3 | Manifest name, description, toolbar title; Chrome owns selection                                                                                                         |
| `options_`     |              45 | Options shell, account empty/error/installations/actions, display controls, permission/configuration guidance                                                            |
| `language_`    |              11 | Selector autonyms, auto/help, save/live status and failure                                                                                                               |
| `auth_`        |              26 | Device initiation/code/copy/URL/expiry/cancel, waiting/connected/denied/expired and structured failures                                                                  |
| `diagnostics_` |              57 | Input validation, matched account/coverage, all ten outcomes, endpoints and rate-limit evidence                                                                          |
| `reviewers_`   |              15 | Loading/section/team, title/ARIA patterns, requested plus four completed states, four confirmed still-requested combinations, and the unverified previous-review pattern |
| `banner_`      |              22 | Six access/failure kinds, configure/sign-in/reload/dismiss, usage and reset-time variants                                                                                |

The catalog currently has 179 keys per locale. `tests/i18n-catalog-drift.test.ts`
asserts these counts against the English catalog and fails when a message key
has no consumer, so update this table and remove dead keys in the same change.

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

#175 adds `auth_cancelling` and `auth_error_restart` in all five
catalogs. These distinguish pending cancellation acknowledgement and a flow that
needs a fresh sign-in after interruption. They keep technical attempt identity
in state and translate guidance only at render time. The implementation owner
reviewed both keys and the README boundary/recovery additions against English,
including Traditional Chinese terminology independently; no external
native-speaker certification is claimed.

## Five-language glossary

These are context-specific display terms, not translations of API enum values.

| Meaning                       | English                       | 한국어                | 日本語                       | 简体中文             | 繁體中文                   |
| ----------------------------- | ----------------------------- | --------------------- | ---------------------------- | -------------------- | -------------------------- |
| Review requested              | requested                     | 리뷰 요청됨           | レビュー依頼中               | 已请求审阅           | 已要求審查                 |
| Approved                      | approved                      | 승인됨                | 承認済み                     | 已批准               | 已核准                     |
| Changes requested             | changes requested             | 변경 요청됨           | 変更要求済み                 | 已请求更改           | 已要求變更                 |
| Commented                     | commented                     | 의견 남김             | コメント済み                 | 已评论               | 已留言                     |
| Dismissed review              | dismissed                     | 리뷰 무효화됨         | レビュー取り消し済み         | 审阅已撤销           | 審查已撤銷                 |
| Still requested               | still requested               | 리뷰 요청 유지 중     | 引き続きレビュー依頼中       | 仍请求审阅           | 仍要求審查                 |
| Re-request timing unavailable | re-request timing unavailable | 재요청 시점 확인 불가 | 再依頼の時点を確認できません | 无法确认再次请求时间 | 無法確認再次要求審查的時間 |
| GitHub App installation       | GitHub App installation       | GitHub App 설치       | GitHub Appのインストール     | GitHub App 安装      | GitHub App 安裝            |
| Repository                    | repository                    | 저장소                | リポジトリ                   | 仓库                 | 儲存庫                     |
| Rate limit                    | rate limit                    | 요청 한도             | レート制限                   | 速率限制             | 速率限制                   |
| Username (GitHub login)       | username                      | 사용자 이름           | ユーザー名                   | 用户名               | 使用者名稱                 |
| Sign in                       | Sign in                       | 로그인                | ログイン                     | 登录                 | 登入                       |
| Token                         | token                         | 토큰                  | トークン                     | 令牌                 | 權杖                       |
| Refresh installations         | Refresh installations         | 설치 정보 새로고침    | インストール情報を更新       | 刷新安装信息         | 重新整理安裝資訊           |
| Pull request                  | pull request (PR)             | 풀 리퀘스트 (PR)      | プルリクエスト (PR)          | 拉取请求 (PR)        | 提取要求 (PR)              |
| Open pull request             | open PR                       | 열린 PR               | オープンなPR                 | 未关闭的 PR          | 未關閉的 PR                |
| Rate-limit reset              | reset                         | 초기화                | リセット                     | 重置                 | 重設                       |
| Unauthenticated (no token)    | unauthenticated               | 비로그인              | 未認証                       | 未登录               | 未登入                     |
| Authorize (device sign-in)    | authorize                     | 권한 부여             | 認可                         | 授权                 | 授權                       |

Device sign-in "authorize" stays distinct from review "approved" (승인됨,
承認済み, 已批准, 已核准). Locales keep their own sentence punctuation: CJK
catalogs use full-width `：` and `。` with no space after `。`, and every
catalog writes the ellipsis as `…`. `tests/i18n-catalog-drift.test.ts` rejects
the superseded variants (for example 레이트 제한, 미인증, サインイン, 未完了, 未认证,
未驗證 and 請求) in catalogs and the matching README.

`DISMISSED` means an existing review was dismissed, not that a PR was rejected
or a notification was closed. `COMMENTED` does not override a prior non-comment
completed review. A requested reviewer can retain completed evidence; the refresh
badge needs a confirmed later `review_requested` event. When bounded event evidence
is incomplete or unavailable, the localized title and accessible name say that the
review is requested, retain the previous completed state, and report that re-request
timing is unavailable. Teams show requested teams, never
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

## Executed evidence

The dated 2026-09-04 execution record (native-locale probe results, packaged
five-locale screenshots and the validation run) is kept in
[releases/localization-qa-2026-09-04.md](releases/localization-qa-2026-09-04.md).
To reproduce the localization checks:

```bash
pnpm test:e2e:build
pnpm exec playwright test tests/e2e/locale-platform.spec.ts tests/e2e/options-localization.spec.ts tests/e2e/reviewer-localization.spec.ts --project=default --workers=1
```

## Store copy and capture maintenance

The five [store listing files](chrome-web-store-submission.md#per-locale-dashboard-checklist)
link directly to catalog name/summary values. Update their detailed copy and
reviewed composition captions alongside terminology changes; the existing README
summary must also match the English catalog. Keep Simplified and Traditional
Chinese as separately reviewed regional copy.

After integrating catalog and UI corrections, run `pnpm cws:assets`,
`pnpm verify:locales` and `pnpm verify:cws`. Inspect all three scenes in each
locale for CJK glyphs, wrapping, cropping, focus and caption overlap. Repeat the
capture on the same Chromium/platform/system-font environment and compare all
15 hashes. Commit the images and capture manifest together. English stays in
the asset root; the other four locales use named subdirectories.

These screenshots select a persisted manual UI language and use synthetic
fixtures plus TESTING GitHub App configuration. They do not replace the native
platform evidence above or production checked-package verification. Store
metadata selection is independent of the UI override. Register detailed copy
and matching screenshots separately using the existing dashboard/release handoff;
promotional tiles remain global. See the [capture procedure and limitations](chrome-web-store-submission.md#capture-maintenance).
