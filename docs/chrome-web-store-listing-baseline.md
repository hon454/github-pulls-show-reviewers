# Reusable saved-listing baseline

This contract supports the [ordinary release route](./chrome-web-store-agent-runbook.md#choose-the-release-route)
without requiring another browser session when existing saved descriptions and
images are unchanged. It is separate from the one-hour, draft-bound
[`listing-ready` handoff](./chrome-web-store-agent-runbook.md#listing-ready-json-and-separate-submission).

The reviewed record belongs at `docs/chrome-web-store-listing-baseline.json`.
No successful record is supplied by this implementation: create one only from
actual saved/reopened dashboard evidence and review it into `main`. Its absence
is reported as `listing-missing`, not silently treated as ready. The status job
reads this file from freshly fetched `origin/main`, even when observing an old
package source or running new status code on a reviewed implementation branch.
A local uncommitted file or a record present only on the control branch cannot
establish a reviewed baseline.

## Record contract

The strict runtime schema is
[`listingBaselineSchema`](../scripts/release/listing.ts). Unknown fields are
rejected. Do not put credentials, raw browser errors or account-sensitive
screenshots in the record or its evidence.

| Field                    | Required value                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`          | `1`                                                                                                          |
| `state`                  | `"verified"` after actual verification; `"invalidated"` when contradicted or superseded                      |
| `repository`             | `"hon454/github-pulls-show-reviewers"`                                                                       |
| `publisherId` / `itemId` | The verified non-secret publisher and extension IDs                                                          |
| `sourceSha`              | Full 40-character reviewed commit containing the description/image files, reachable from fresh `origin/main` |
| `locales`                | Exactly five records, once each for `en`, `ko`, `ja`, `zh_CN`, `zh_TW`                                       |

Each locale record has these fields:

| Field               | Required value                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `locale`            | One of the five codes above                                                                                                                                                                  |
| `observedAt`        | Actual saved/reopened verification timestamp in UTC ISO format, never in the future                                                                                                          |
| `evidenceUrl`       | Same-repository `https://github.com/.../issues/N#issuecomment-N` or full commit permalink containing the verification ledger and evidence; no credentials, query, port or arbitrary fragment |
| `savedAndReopened`  | `true`, attesting an actual observation of the complete persisted description and three images after navigation away and back                                                                |
| `descriptionSha256` | SHA-256 of the **entire UTF-8 description source file** at `sourceSha`, not a claimed remote hash                                                                                            |
| `imageSha256`       | Exactly three SHA-256 strings in `01`, `02`, `03` order, identifying the local source files used in the visual comparison                                                                    |

Descriptions are `docs/chrome-web-store-locales/{locale}.md`. Screenshots are
`01-pr-list-before-after.png`, `02-pr-list-avatar-state-showcase.png`, and
`03-options-repository-check.png` under `docs/chrome-web-store-assets/` for
English or its `{locale}/` subdirectory for the other languages. Paths/order are
fixed by `listingPaths`; records cannot select arbitrary files. Compare the
complete description between the source's description markers, and visually
confirm each persisted image and its order. Record source-file hashes alongside
that evidence. Dashboard previews do not expose an image-byte digest, so do not
claim remote hash verification.

Evidence links and `savedAndReopened: true` are operator attestations, not
independent proof. The maintainer must inspect the real ledger and observations
when reviewing the record into `main`. Schema/hash checks cannot prove that a
permalink contains truthful evidence. A save toast, generated capture manifest,
local source equality, or automatically populated JSON is insufficient.

## Reuse, changes and contradictions

The status reader validates item identity, locale completeness, evidence URL
shape/repository, timestamps, reviewed baseline source ancestry, and every file
hash at that source before comparing the selected release source. Package
version changes and the age of saved-content evidence alone do not invalidate
it. The capture manifest's wider build/dependency source hashes do not replace
this saved-content record and do not force a dashboard save for an unchanged
listing.

- `unchanged`: every current description and image matches the verified
  baseline. Ordinary readiness can use API status and trusted receipts without
  browser tools or dashboard login.
- `changed`: the baseline is valid, but current files differ. The report names
  affected locales. Use checked staging and authorized listing work.
- `missing`: there is no reviewed record. Reconcile saved content and record
  actual evidence; do not assume readiness from local hashes.
- `conflicting`: invalidated/malformed evidence, wrong identity, missing or
  duplicated locale, untrusted source, or a hash/evidence mismatch. Inspect the
  specific evidence and reconcile saved content before recording a replacement.

A dashboard edit, contrary observation, source mismatch or lost evidence must
invalidate or replace the baseline through review. Do not keep reusing an old
`verified` record after discovering a contradiction. The API cannot detect
unrecorded dashboard edits; operator continuity remains part of this contract.
A package receipt and a reusable listing baseline prove different things:
receipt hashes establish checked artifact provenance, while the listing record
binds source files to actual saved-content observations. Neither proves remote
draft ZIP identity.

The status report documents the route and blockers. It never authorizes a CWS
write, changes the existing mutation policy, or supplies `listing-ready` evidence
to `submit-existing`. Complete the runbook's readiness and authorization checks;
later execution still performs its own fresh API/receipt checks. Do not upload,
submit, cancel review, move a tag or edit the dashboard merely to validate this
contract.
