# Staged Chrome Web Store agent handoff

This runbook separates a checked package upload from listing registration and
review submission. It does not authorize a release by itself. Use the assigned
release source and approved listing materials; do not manufacture a production
test upload. For v1.16.0, wait for the actual #152/#153 artifacts before doing
the #154 dashboard handoff. The five locales are `en`, `ko`, `ja`, `zh_CN`, and
`zh_TW`; runtime language UI and store listing languages are separate surfaces.

## Action matrix

This matrix applies only when the selected **control ref contains the updated
workflow**. GitHub executes workflow code from `--ref`; old tags are immutable
snapshots, so `--ref v1.15.0` still runs the legacy publish condition and is not
safe for skip/dry-run. Do not dispatch a legacy workflow ref or move old tags.

| Event/input                                                     | CWS behavior                                                         | GitHub Release                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| Push a new `v<version>` tag                                     | Checked upload, then normal review/automatic publication             | Create/refresh after success                |
| Push a tag for an exact staged source already pending/published | Verify original receipt, artifact and current state; no CWS write    | Create/refresh using original zip           |
| Dispatch `skip` on a branch or tag                              | No CWS access                                                        | Only if an existing version tag is selected |
| Dispatch `dry-run` on a branch or tag                           | Authenticate both supported clients, read status only                | Never                                       |
| Dispatch `publish`                                              | Checked upload + submit, or verified already-pending/published no-op | Only if an existing version tag is selected |
| Dispatch `upload-only`                                          | Checked upload only                                                  | Never                                       |
| Dispatch `submit-existing`                                      | Publish existing revision only; zero upload calls                    | Never                                       |

Staging requires an exact 40-character `source_sha` and bare `expected_version`.
Do not provide the `tag` input for either staging action. A dispatch selected
against a tag still obeys its explicit action. All mutations require both the
workflow control commit and package source to be reachable from freshly fetched
`origin/main`; source code is checked out separately from control code. All
mutations rerun production preflight, release verification and checked packaging.

After the new workflow is integrated, select updated `main` as the control ref
and choose an old package tag separately:

```bash
gh workflow run release.yml --repo hon454/github-pulls-show-reviewers \
  --ref main -f tag=v1.15.0 -f chrome_web_store=skip
```

This skips CWS but may refresh the GitHub Release for that existing tag. For
credential-only checks, use updated `main` after integration or the exact
reviewed branch before integration, as in the next example; do not use an old
tag as the workflow control ref.

## Credential-only rehearsal

After independent review and CI on the exact PR head, verify the branch still
points to that reviewed SHA, then dispatch:

```bash
gh workflow run release.yml --repo hon454/github-pulls-show-reviewers \
  --ref codex/issue-153-staged-cws-release -f chrome_web_store=dry-run
```

Record the resulting run URL, head SHA, and successful **Check Chrome Web Store
credentials** step. Confirm source checkout, package build, CWS execution and
GitHub Release steps were skipped. Branch dry-run is supported before merge; it
does not require the mutation-only main ancestry gate. Use `--ref main` after
integration. Never read/print credential values, OAuth tokens, headers, or raw
API errors. The private key remains the directly masked Actions secret.

## 1. Upload the reviewed package

Before running, record the actual full release SHA and expected version. That
source must already contain the version bump, `docs/releases/v<version>.md`,
five locale catalogs and approved listing/screenshot materials. Confirm no
other operator is editing/uploading the item's package. Workflow concurrency
serializes automation but cannot lock the Developer Dashboard against others.

```bash
gh workflow run release.yml --repo hon454/github-pulls-show-reviewers \
  --ref main -f chrome_web_store=upload-only \
  -f source_sha=REPLACE_WITH_REVIEWED_40_CHARACTER_SHA \
  -f expected_version=1.16.0
```

The job saves `chrome-package-<run-id>`, then `cws-intent-<item-id>` before its
first possible write. `cws-result-<item-id>` records the observed result even if
the operation exits unsuccessfully. A successful upload receipt has
`upload: SUCCEEDED`, `submission: NOT_ATTEMPTED`, and `outcome: UPLOADED`.
Download artifacts through `gh run download <run-id>` for inspection; generated
receipts/zips are not repository source files. Store no credentials in them.

The receipt records the repository, workflow/run identity, exact source SHA,
expected manifest version, publisher/item, exact checked zip SHA-256, immutable
package artifact ID/name/digest, state and timestamp. Save the original run URL
and receipt with the handoff. GitHub API validation verifies trusted commit
ancestry and all checked build steps before a later consumer accepts it.

## 2. Register listing materials and record the handoff

After upload succeeds, let the workflow finish. No runner waits for dashboard
editing. Use the separately approved #152 materials to save descriptions and
screenshots for English, Korean, Japanese, Simplified Chinese and Traditional
Chinese. Record each saved locale and the evidence permalink in the release
tracking issue. Do not press a dashboard submit/publish/cancel button or upload
another package as part of listing registration.

Immediately before submission, inspect the current dashboard draft version and
compare it with the original receipt. Also confirm the item identity, all five
saved listings, and that no package upload intervened. API `fetchStatus` does
not provide a remote draft ZIP digest or a reliable draft-version field; a
matching local hash/package.json is not proof of remote draft identity.

Create a local JSON handoff file, substituting the actual receipt values:

```json
{
  "receiptRunId": "123456789",
  "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "zipSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "itemId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "version": "1.16.0",
  "observedAt": "2026-09-04T08:00:00.000Z",
  "evidenceUrl": "https://github.com/hon454/github-pulls-show-reviewers/issues/154#issuecomment-123456789",
  "listingReady": true,
  "noInterveningUpload": true,
  "draftVersionVerified": true,
  "locales": ["en", "ko", "ja", "zh_CN", "zh_TW"]
}
```

The permalink must be a credential-free HTTPS URL in this repository (no query
string). Evidence must be newer than the upload receipt and at most one hour
old when the CWS step runs. Refresh it if queueing or validation takes longer.
These are explicit operator attestations, not a claim that the API proves the
draft's bytes. Unknown fields, wrong locale sets, stale timestamps and mismatched
receipt/source/item/version/hash are rejected before submission.

## 3. Submit the existing uploaded revision

```bash
gh workflow run release.yml --repo hon454/github-pulls-show-reviewers \
  --ref main -f chrome_web_store=submit-existing \
  -f source_sha=REPLACE_WITH_REVIEWED_40_CHARACTER_SHA \
  -f expected_version=1.16.0 -f receipt_run_id=123456789 \
  -F listing_evidence=@/absolute/path/listing-ready.json
```

The workflow restores and rechecks the original checked zip artifact. It never
uploads it. After fresh status and evidence validation, the adapter performs
one CWS v2 `publish` call with normal review (`skipReview: false`), immediate
publication after approval (`DEFAULT_PUBLISH`) and blocking warnings. A matching
already-pending/published receipt is reported without another write. Keep the
result run URL and listing-ready artifact alongside the original upload run.

## 4. Add the later tag/GitHub Release

After the staged submission is confirmed, create `v1.16.0` at the **same source
SHA that was uploaded**, following the normal authorized tag procedure. Do not
tag a later documentation-only or integration commit under the same version.
The push workflow discovers the item-wide receipts, verifies the selected
source/version/artifact, reads current CWS state and skips upload/submission
when that source is already pending or published. It attaches the original zip
to the GitHub Release and uses `docs/releases/v1.16.0.md` from that source.
Missing/mismatched provenance stops the job; it never guesses from version
equality. An ordinary new version without a prior receipt keeps automatic
checked upload-and-submit behavior.

## State and recovery rules

| Observed state                                                                                               | Allowed next action                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Checked upload `SUCCEEDED`, no submission                                                                    | Finish listings, refresh dashboard evidence, submit-existing                                      |
| Upload response `IN_PROGRESS`                                                                                | Read-only status polling; no reupload                                                             |
| Prior `IN_PROGRESS`, API now `lastAsyncUploadState: SUCCEEDED`, dashboard version/listings freshly confirmed | Add `asyncUploadConfirmed: true` to the handoff and use submit-existing with the original receipt |
| Upload `UNKNOWN`, missing result, timeout or interrupted process                                             | Inspect status/dashboard/intent; stop for an explicit recovery decision; never blind retry        |
| Expected receipt/version pending review or published                                                         | Read-only no-op; tag may refresh GitHub Release artifacts                                         |
| Submission `UNKNOWN` but expected receipt/version is pending/published                                       | Report that remote state; no resubmission                                                         |
| Submission uncertain and API still shows draft                                                               | Stop for an explicit recovery decision                                                            |
| Conflicting source/version, rejected/cancelled/staged revision, warning/takedown, missing/expired evidence   | Stop; no cancellation, overwrite, or skip-review                                                  |

The SDK rejects any upload response other than `SUCCEEDED`; the adapter preserves
`IN_PROGRESS` separately. Async recovery is accepted only while the API exposes
the successful async result (normally within 24 hours), with explicit fresh
dashboard evidence and no intervening upload. A timeout/unknown response cannot
be promoted to success just because a local zip exists. Lost intent/result
artifacts or unconfirmable outcomes require a separately reviewed recovery
decision, not another upload flag or production dummy version.

Start a **new dispatch**, not a rerun of the old workflow attempt, after deciding
the next allowed action. Intent/result artifacts are immutable and retained for
90 days; complete staging and tagging within that period. Preserve active
artifacts and handoff evidence. Expiry, deletion or incomplete provenance stops
automatic reuse. All automation for the same item uses one non-cancelling queue;
operator exclusivity is still required for dashboard/package edits.

API references: [upload](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload),
[publish](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish),
[fetchStatus](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus).
