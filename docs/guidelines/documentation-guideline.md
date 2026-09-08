# Documentation Guideline

This document defines README language ownership, translation maintenance, and
the companion documents required when repository behavior changes.
[AGENTS.md](../../AGENTS.md#documentation-policy) makes this policy part of the
agent workflow; contributors use it with the
[PR co-location checklist](./pr-guideline.md#co-location-checklist).

## README language map

| Language | File                                     | Role                                       |
| -------- | ---------------------------------------- | ------------------------------------------ |
| English  | [README.md](../../README.md)             | Canonical source for meaning and structure |
| 한국어   | [README.ko.md](../../README.ko.md)       | Korean translation                         |
| 简体中文 | [README.zh-CN.md](../../README.zh-CN.md) | Simplified Chinese translation             |
| 繁體中文 | [README.zh-TW.md](../../README.zh-TW.md) | Traditional Chinese translation            |
| 日本語   | [README.ja.md](../../README.ja.md)       | Japanese translation                       |

All five files live at the repository root so shared relative links and image
paths resolve identically. Each README includes the same language navigation
immediately after the badges, in the order above, with its current language in
bold and the other four linked by their native names.

README filenames use `zh-CN` and `zh-TW`. Chrome catalog and store-copy paths
retain `zh_CN` and `zh_TW`; do not rename those runtime or store assets to match
the README convention.

## Translation and synchronization

- English defines the complete content and section order. Reflect changes to
  meaning, sections, commands, links, and shared assets in every translation
  in the same PR. Do not leave translations as shortened summaries.
- A wording or spelling correction confined to one locale can update only
  that file if its meaning and structure remain aligned with English. Explain
  that scope in the PR description.
- Translate prose, headings, link labels, and meaningful image alternative text.
  Keep product names, GitHub identifiers, permission strings such as
  `Pull requests: Read`, commands, paths, URLs, API values, and code unchanged.
- Use the [five-language glossary](../localization.md#five-language-glossary)
  for review states and authentication terminology. Review each translation
  against English separately. Traditional Chinese requires its own terminology
  and phrasing review, not just Simplified Chinese character conversion.
- Preserve behavioral distinctions: comments do not override an existing
  non-comment review; requested teams do not imply team approval; local account
  removal does not revoke the GitHub App; rate-limit expiry does not resume
  reviewer loading automatically.
- Reuse existing shared screenshots and translate their alternative text.
  Shared screenshots may show English UI; they do not prove native-language
  browser verification. If localized screenshots are introduced, map equivalent
  scenes explicitly and preserve asset provenance.
- Keep detailed architecture, contributor, privacy, and release procedures in
  their canonical English documents. The READMEs provide equivalent user-facing
  explanations and links, and disclose that linked detailed documents are in
  English. A README translation does not translate or replace those documents.

## Change-to-document map

“All READMEs” means the five files in the language map. Update only the rows
that apply to the change, in the same PR. Follow linked runbooks for execution
and authorization; this table does not grant release or store-write permission.

| Change                                                                              | Companion documentation                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reviewer behavior, supported review states, user-visible settings, or product scope | All READMEs and [implementation notes](../implementation-notes.md); update the [glossary](../localization.md#five-language-glossary) when terminology changes                                                                                                      |
| README content, structure, commands, links, or shared images                        | All READMEs; locale-only wording corrections follow the exception above                                                                                                                                                                                            |
| Permissions or host access                                                          | [Privacy policy](../privacy-policy.md), [store submission packet](../chrome-web-store-submission.md), and all READMEs when access/privacy explanations change                                                                                                      |
| Storage or credential retention                                                     | [Privacy policy](../privacy-policy.md); all READMEs when account persistence/removal guidance changes                                                                                                                                                              |
| Sign-in, device flow, or repository access                                          | [Manual Chrome testing](../manual-chrome-testing.md), [implementation notes](../implementation-notes.md), and all READMEs when user instructions change                                                                                                            |
| Supported languages or extension UI translations                                    | [Localization ownership and glossary](../localization.md), all five `public/_locales/` catalogs and their typed contract as applicable; all READMEs when language support or user-visible behavior changes                                                         |
| Release behavior, packaging, or store submission requirements                       | All READMEs, [CWS notes](../chrome-web-store.md), and [submission packet](../chrome-web-store-submission.md); update the [agent runbook](../chrome-web-store-agent-runbook.md) and [staged action reference](../cws-agent-handoff.md) when their procedures change |
| Store descriptions or screenshots                                                   | [CWS notes](../chrome-web-store.md), [submission packet](../chrome-web-store-submission.md), affected files in `docs/chrome-web-store-locales/` and `docs/chrome-web-store-assets/`; all READMEs if linked assets or product claims change                         |
| Contributor commands or verification workflow                                       | [CONTRIBUTING.md](../../CONTRIBUTING.md); all READMEs if their quick-start or validation commands change                                                                                                                                                           |
| New or moved entrypoint or major module                                             | Repository Map in [AGENTS.md](../../AGENTS.md#repository-map)                                                                                                                                                                                                      |
| Version bump                                                                        | Corresponding `docs/releases/vX.Y.Z.md`                                                                                                                                                                                                                            |
| Durable architecture decision                                                       | Corresponding document in [docs/adr/](../adr/)                                                                                                                                                                                                                     |

## Verification checklist

Before submitting a documentation change:

1. Compare every translated section with English for information coverage,
   order, review semantics, permissions, sign-in, and account removal behavior.
2. Verify the five-language navigation, relative file links, heading anchors,
   and image paths. Translate link labels without changing shared targets;
   links to translated headings must use their actual localized anchors.
3. Compare code blocks and literal identifiers with English. Keep badge/store
   destinations, attribution query parameters, and shared image paths aligned.
4. Run Prettier on changed Markdown files and `git diff --check`. A documentation
   change alone does not require generating store screenshots or release ZIPs.
5. Record checks actually performed and any unverified language or browser
   behavior in the PR's Testing section. Do not claim native-speaker review or
   live browser verification based on translation or file checks alone.

Structural and link checks can detect omissions and broken navigation; they do
not establish translation accuracy. Review meaning separately against English.
