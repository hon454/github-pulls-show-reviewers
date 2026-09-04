# 0006 — Bundled localization and render-only language changes

Status: Accepted for the localization foundation (#147). Feature surfaces follow
in #148 (options/auth), #149 (diagnostics), and #150 (reviewers/banners).

## Decision

`public/_locales/{en,ko,ja,zh_CN,zh_TW}/messages.json` is the single source of
message text for both Chrome metadata and the extension UI. Static JSON imports
bundle the five small catalogs; no service, remote resource, new permission,
row-level catalog load, or WXT upgrade is needed. Product and GitHub App names
remain unchanged. Every message has a context description. Sentences belong in
messages, not concatenated English fragments. Render strings via React text
children or DOM `textContent`, never translation HTML.

Chrome resolves manifest `__MSG_…__` references using its own language and
`default_locale: en`. The in-extension override cannot change Chrome-owned
name, description, or toolbar metadata. Extension UI resolves `auto` from
`browser.i18n.getUILanguage()`, never GitHub's document language or the ordering
of `navigator.languages`. Hyphens, underscores and case are normalized. English,
Korean and Japanese variants map to `en`, `ko` and `ja`. Chinese Hans/Hant script
wins over region; otherwise CN/SG and bare zh map to `zh_CN`, TW/HK/MO to
`zh_TW`. Unsupported languages fall back to English. `toLanguageTag` supplies
BCP 47 tags (`zh-CN`, `zh-TW`) for HTML `lang` and Intl formatting.

## Public API and key ownership

The pure `src/i18n/index.ts` facade exports `Locale`, `LanguagePreference`,
`SUPPORTED_LOCALES`, `resolveLocale`, `toLanguageTag`, `createTranslator`,
`formatMessage`, `MessageKey`, `MessageArgs`, `MessageValues`, `Translator`,
`LocalizedMessage`, `createLocaleStore` and its adapter/store/snapshot types.
It reads no browser globals and imports no React. `createTranslator(locale)`
returns synchronous `t(key, args)`; keys without arguments take only a key.
`MessageArgs` is the typed named-argument contract. `LocalizedMessage` is a
key/args discriminated union for presentation descriptors.

All new keys must be added to `MessageArgs` and all five catalogs together.
Named Chrome placeholders use lowercase names and unique contiguous positional
contents (`"login": { "content": "$1" }`). Translators may reorder or repeat
`$LOGIN$` in a complete sentence while preserving that contract. Interpolation
uses the named TypeScript argument, not English position or concatenation;
substituted values are inert and never reparsed. `$$` renders a literal dollar.
Missing locale keys fall back to English; an unknown key renders its key, and
missing arguments remain visible as placeholders for diagnosis.

| Owner | Namespace / responsibility                                                     |
| ----- | ------------------------------------------------------------------------------ |
| #147  | `extension_`, core contracts, locale resolver/store, preference migration      |
| #148  | `options_`, `language_`, `auth_`, options/auth presentation                    |
| #149  | `diagnostics_`, structured error evidence and presentation mapping             |
| #150  | `reviewers_`, `banner_`, content rendering and language-only event integration |

The catalog validator checks key parity, nonempty text/descriptions and matching
placeholder contracts. `pnpm build && pnpm verify:locales` verifies exactly five
emitted locale directories, canonical source parity, metadata references and
Chrome's 75/132 character name/description limits. The checked GitHub App
packaging gate remains unchanged.

## Preference and lifecycle contract

`preferences` remains version 1 and gains
`language: 'auto' | 'en' | 'ko' | 'ja' | 'zh_CN' | 'zh_TW'` (default `auto`).
Missing or invalid language repairs only that field; old valid display booleans
survive. `updatePreferences` merges a language or display patch with the other
current preferences. Account/token keys and storage schemas are untouched.

`src/i18n/browser.ts` exposes lazy `getLocaleStore()` for one store per extension
context. The browser adapter reads/writes only the preferences key and filters
storage events to the local area. The store exposes:

- `getSnapshot()` returns a stable immutable `{ language, locale, lang, t }`.
  Before hydration it uses Chrome auto detection. Unchanged language events do
  not replace the snapshot or notify.
- `subscribe(callback)` returns an idempotent unsubscribe. The first subscriber
  attaches one storage listener **before** the initial async read. More
  subscribers share it. The last unsubscribe removes it and invalidates pending
  reads. Re-subscribing re-reads storage to recover changes during inactivity.
- `ready()` waits for the active hydration. With no subscribers it borrows a
  temporary subscription, hydrates, then releases it. Thus DOM initialization
  may `await store.ready()` then synchronously read a snapshot; ongoing UI should
  subscribe first and then await `ready()` to retain future updates. Reading a
  snapshot alone does not start storage I/O.
- `setLanguage(preference)` persists through the preference patch API and returns
  a promise. Rapid selections are serialized; failures reject without poisoning
  later writes. Storage events invalidate older reads and take precedence over
  delayed write completions. Failed writes do not invalidate a valid initial
  read. A storage read failure uses Chrome auto while preserving later events.
- `dispose()` is terminal for that store, removes its listener and suppresses
  pending read/write notifications. Normally the root owner disposes at context
  teardown; individual components only unsubscribe. The browser accessor creates
  a fresh singleton after disposal. A stale disposer cannot discard its successor.

`src/i18n/react.ts` exports `useLocale(store)`, a `useSyncExternalStore` adapter
using an injected context-owned store. React mount/unmount owns the subscription;
DOM roots use the same subscribe/unsubscribe interface. No global document lang
mutation occurs in the core: options sets its own document language, while the
content integration sets language only on extension-owned elements.

## Structured errors and render-only boundary

API/data/runtime objects and review caches retain stable codes, scalar arguments
and original technical evidence. #149 owns mapping those facts to localized
presentation descriptors. Do not parse English error sentences to recover state,
translate technical identifiers, or put localized text in cache/runtime keys.
Copyable raw diagnostic evidence remains unchanged. User-facing error prose is
formatted at render time, allowing the same evidence to display in another locale.

A language change only reformats existing UI; it must not fetch reviewer data,
cancel/restart requests, refresh tokens or modify account selection. #150 must
separate language-only storage changes from the page controller's data refresh
path and retain completed/in-flight data. #147 provides the store and tests this
boundary in isolation; feature integration is intentionally owned by those
follow-up issues, not implemented in the foundation.
