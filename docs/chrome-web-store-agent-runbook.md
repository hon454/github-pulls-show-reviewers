# Chrome Web Store agent runbook

This is the canonical procedure for an authorized agent to stage a checked
release, register five localized listings, verify saved content, and hand off
or submit for normal review. **Manual means a deliberate supported dashboard
step; an agent may execute it under the session's authorization.** Preserve
that authorization across interruptions instead of requesting it on each click.
This document is a procedure, not permission to perform a production release.

The implementation contracts are [release.yml](../.github/workflows/release.yml),
[policy.ts](../scripts/release/policy.ts), [engine.ts](../scripts/release/engine.ts),
[provenance.ts](../scripts/release/provenance.ts), [cli.ts](../scripts/release/cli.ts),
[cws.ts](../scripts/release/cws.ts), and [ADR 0007](./adr/0007-receipt-bound-staged-cws-release.md).
The [staged handoff reference](./cws-agent-handoff.md) summarizes action semantics;
the [submission packet](./chrome-web-store-submission.md) owns listing/privacy
materials and the [store notes](./chrome-web-store.md) own configuration.

## Copy-paste assignment and resume contract

Fill every placeholder from reviewed source, actual receipts and current state.
Use `not yet created` for artifacts before upload; fill them from the completed
upload run before any listing write. Never invent a successful receipt.

```text
Task: stage/register the localized Chrome Web Store release.
Repository: hon454/github-pulls-show-reviewers
Release issue / milestone: <issue URL> / <milestone URL>
Reviewed release sourceSha: <full 40-character SHA reachable from fresh origin/main>
Expected bare version: <version from that source, its ZIP manifest and release notes>
Release notes: docs/releases/v<version>.md
Workflow control ref: main (updated release workflow); resolved workflowSha: <SHA>
Publisher ID / dashboard account role: <expected publisher; non-sensitive account label>
Store itemId: hoocgjopdboeghdkfjlkngkkpbiljggk (verify against receipt and dashboard)
Upload receipt run ID / URL: <original run, not the later submission run>
Intent / result evidence: <downloaded intent.json and result.json paths + permalinks>
Checked package: <artifact ID / chrome-package-RUN_ID / artifactDigest>
ZIP: <absolute downloaded path / zipName / package.zipSha256>
Listing source: <same reviewed source SHA>
Descriptions: docs/chrome-web-store-locales/{en,ko,ja,zh_CN,zh_TW}.md
Images and source hashes: docs/chrome-web-store-assets/capture-manifest.json
Expected current state / observedAt: <upload pending, draft, partial listing, etc. / UTC>
Per-locale resume ledger: <path or permalink; completed evidence and missing work>
Permitted stages: <read-only; upload-only; listing descriptions/screenshots; evidence recording>
Submit for review authority: <yes/no + existing session instruction reference>
Tag / GitHub Release authority: <yes/no + exact same-source tag + instruction reference>
Issue/milestone closure authority: <yes/no; only after acceptance evidence>
Evidence destination: <absolute directory + same-repository issue/comment permalink destination>
Evidence posting authority: <existing instruction covering release report publication, or local handoff only>
Exclusive item/package operator: <owner and handoff; no concurrent dashboard/package edits>
Exact next action: <first incomplete stage and its prerequisites>
Limitations: <missing login/tool/receipt/authority, untested live operations>
```

Read-only checks and scoped, already-authorized edits proceed. If submission is
not authorized, finish the listings and evidence, report readiness, and request
only the separate submission decision. Listing authority does not imply tag,
GitHub Release, privacy/distribution/pricing, or review-cancellation authority.
Payment, a material scope change, ambiguous account choice, conflicting draft
state, or a missing permission requires appropriate user input. Return control
for login/MFA/CAPTCHA; never ask for pasted credentials or bypass authentication.
Unavailable browser tooling is a handoff boundary, not a reason to invent a
private API. Preserve completed work and give the exact next action.

## Identity and preflight

Keep these identities separate in every report:

| Identity | Authoritative observation |
| --- | --- |
| Reviewed source | Full `sourceSha`, source `package.json`, notes and approved assets |
| Version | Bare manifest version; equal numbers alone do not identify a draft/package |
| Workflow control | `--ref main` resolves the updated control code; record actual run `headSha` / receipt `workflowSha` separately from package source |
| Store item | Receipt `publisherId` and `itemId`, visually matched to the selected dashboard account/item |
| Checked ZIP | `package.zipName` and `package.zipSha256` of the inner extension ZIP |
| GitHub artifact | `package.artifactId`, `artifactName`, `artifactDigest`; this digest covers the outer Actions artifact archive, not the inner ZIP |
| Receipt run | Original upload `runId`, `runAttempt: "1"`, `runUrl`, workflow path and successful gates; later receipts may contain `priorReceiptRunId` |
| Actual draft | Fresh visual draft-version check, receipt/history continuity and no-intervening-upload attestation; CWS API has no remote draft ZIP digest |

Discover the installed tools at execution time. Prefer `gh` or an available
purpose-built public workflow/status/artifact API for GitHub; use an available
supported browser/UI tool for the signed-in Developer Dashboard. Do not require
a particular agent application's tool name, use private dashboard endpoints,
or call the upload SDK/`pnpm submit:chrome` as a standalone shortcut. Read current
UI labels and accessibility structure; fixed coordinates are not a procedure.

In your own checkout, fetch `origin/main` and tags, read the assigned exact
source, and confirm both source and workflow commits are reachable from fresh
main. Confirm source version, notes, default locale `en`, all five catalogs and
approved listing materials. Run `pnpm verify:cws` there; its capture manifest
binds source hashes (including `package.json`) and all 15 image hashes. If source
inputs changed, recapture and review via the submission packet before release;
capture uses a TESTING build, so it is not production package verification.
The workflow runs `pnpm preflight:release`, `pnpm verify:release`, and
`pnpm zip:checked` against the selected source. Never replace that gate with
plain `pnpm zip` or a dashboard package upload. A later local production build
uses `pnpm zip:release` after TESTING captures.

These instructions assume the updated control workflow. Immutable old tags
retain old code: **never use `--ref v1.15.0`**, even with `skip` or `dry-run`,
and never move an existing tag to retrofit safety. Updated `main` is the safe
control ref; an old package tag is a separate `tag` input only for `skip` or
`publish`. `skip` defaults to no CWS access, but with an existing tag it can
create/refresh a GitHub Release. `dry-run` only authenticates/reads status and
does not build, upload, submit, save artifacts or create a Release. Run that
credential check only when required by a credential/linkage/dependency/publish
change, under its own authorization; writing this runbook requires none.

## Stage table

| Stage | Inputs and action | Expected observation and evidence | Retry / resume and stop condition |
| --- | --- | --- | --- |
| Preflight | Assignment, source/control SHA, version, account/item and exclusive owner; check source, artifacts, tools and scope | Identity ledger; reviewed copy/image hashes; expected state and authorization | Resume from current facts. Stop on identity, authority or tool/login gaps affecting the next action |
| Checked upload | Authorized `upload-only` with exact source/version | Completed run; successful gates; paired intent/result; `upload: SUCCEEDED`, `submission: NOT_ATTEMPTED`, `outcome: UPLOADED`; checked package | Never rerun attempt or blindly reupload. IN_PROGRESS permits read-only observation; UNKNOWN or lost provenance needs recovery decision |
| Per-locale registration | Visually match account/item/draft to receipt; preserve scoped before-state; edit each approved description and ordered images | Correct locale, exact text and three matching previews; record actions and source files | Reopen current state first; retain matching images and replace identified prior-release images within scope. Stop on unidentifiable content or draft change |
| Read-after-save proof | Save each locale, navigate away and back, compare persisted text and images | Five timestamped reopen records with file hashes, order, scoped screenshots/text evidence | A toast or unsaved preview is insufficient. Recheck interrupted saves; never assume failure means nothing persisted |
| Listing-ready | Recheck draft, all five locales, no intervening upload and permission scope | Fresh JSON below plus real same-repository evidence permalink | Refresh after queue/build delays if older than one hour. No submission authority: stop here with ready status |
| Submission | Authorized `submit-existing`, original receipt run, source/version and fresh evidence | New result `SUBMITTED` / `submission: CONFIRMED`, or verified `ALREADY_PENDING` / `ALREADY_PUBLISHED`; save result/evidence artifacts | Zero upload calls. UNKNOWN requires read-only reconciliation; draft after uncertain submission needs explicit recovery, no blind resubmit |
| Pending / published | Read status through supported tools and dashboard; compare receipt/source/version | Record actual pending/rejected/published state and UTC evidence; pending is not published | Observe without cancel/reupload. Rejection, warnings, takedown, cancelled/staged/tester state or conflicting version stop for recovery |
| Later tag / GitHub completion | Separate authority; tag original reviewed source after confirmed staged submission; inspect push workflow and Release | Same source/version, original ZIP reused, `ALREADY_PENDING` or `ALREADY_PUBLISHED`; GitHub Release link and asset hash; finally public five-locale availability | Never tag a later commit under that version. Missing/expired receipt stops reuse. Close release issue/milestone only under authority and after actual publication/acceptance |

## Checked upload and artifact inspection

Set `SOURCE_SHA`, `VERSION`, `UPLOAD_RUN_ID`, `ITEM_ID` and `EVIDENCE_DIR` from the
assignment/receipt, using ordinary shell variables (no credentials). Commands
below are templates for a separately authorized release, not documentation tests.

```bash
gh workflow run release.yml --repo hon454/github-pulls-show-reviewers \
  --ref main -f chrome_web_store=upload-only \
  -f source_sha="$SOURCE_SHA" -f expected_version="$VERSION"
```

Do not set `tag`, `receipt_run_id` or `listing_evidence` on upload-only. Find the
new run with `gh run list --repo hon454/github-pulls-show-reviewers --workflow
release.yml --event workflow_dispatch`; verify its timestamp, control SHA,
inputs/run details and operator before accepting its ID. Do not guess “latest”
when another dispatch exists. Then inspect/download with:

```bash
gh run view "$UPLOAD_RUN_ID" --repo hon454/github-pulls-show-reviewers \
  --json databaseId,url,headSha,event,status,conclusion,jobs
gh api "repos/hon454/github-pulls-show-reviewers/actions/runs/$UPLOAD_RUN_ID/artifacts"
gh run download "$UPLOAD_RUN_ID" --repo hon454/github-pulls-show-reviewers \
  -n "cws-intent-$ITEM_ID" -D "$EVIDENCE_DIR/upload-intent"
gh run download "$UPLOAD_RUN_ID" --repo hon454/github-pulls-show-reviewers \
  -n "cws-result-$ITEM_ID" -D "$EVIDENCE_DIR/upload-result"
gh run download "$UPLOAD_RUN_ID" --repo hon454/github-pulls-show-reviewers \
  -n "chrome-package-$UPLOAD_RUN_ID" -D "$EVIDENCE_DIR/upload-package"
```

Wait for the run to finish; `conclusion: failure` alone does not disprove an
upload. Compare the sanitized receipts, not raw credential-bearing logs.

| Actions artifact name | Runner path / downloaded member |
| --- | --- |
| `chrome-package-<run-id>` | Initially `release-source/.output/github-pulls-show-reviewers-<version>-chrome.zip`; on reuse `.release/github-pulls-show-reviewers-<version>-chrome.zip`; member is that ZIP basename |
| `cws-intent-<item-id>` | `.release/intent.json` / `intent.json` |
| `cws-result-<item-id>` | `.release/result.json` / `result.json` (saved even after uncertain failure when available) |
| `cws-listing-ready-<submission-run-id>` | `.release/listing-evidence.json` / `listing-evidence.json` (when execution saves evidence) |

`.release/prepared.json` and `.release/downloads/<artifact-id>.zip` are internal
runner files, not named handoff artifacts. Artifacts retain for 90 days; preserve
active receipts and finish staging/tagging before expiry. A local evidence copy
does not bypass the workflow's requirement for live trusted Actions artifacts.

Check `schemaVersion: 1`, repository, workflow path/SHA, source/version,
publisher/item, checked flag, run/attempt/URL, package identity and state against
`receiptSchema`/`validateReceipt`. Provenance validation also checks successful
**Production preflight**, **Release verification**, **Checked package**, and
**Record checked package** steps and paired intent/result history in both
directions. A result without an intent is not an empty history. The workflow
checks artifact archive digest and extracted ZIP digest before reuse.

Hash the downloaded inner ZIP with `shasum -a 256 "$ZIP_PATH"`; compare
`package.zipSha256`. Inspect its `manifest.json` and `_locales` entries with
`unzip -p "$ZIP_PATH" manifest.json` and `unzip -Z1 "$ZIP_PATH"`. If extracting
the verified package to an empty task directory, run from the assigned source:

```bash
pnpm verify:locales "$EXTRACTED_PACKAGE_DIR"
```

That checker compares emitted catalogs to the checkout. Do not run it from an
unrelated source and treat a mismatch as proof of a bad uploaded package.

## Dashboard registration and persisted evidence

1. Discover/select the supported dashboard browser surface and inspect the
   current signed-in account/publisher role, item name/ID and **draft version**.
   Compare them to the original upload receipt before writes. Record UTC and
   only the necessary visible fields, excluding account email/avatar, tokens,
   private tabs and other sensitive regions. Establish exclusive item ownership;
   Actions concurrency cannot lock out another dashboard operator.
2. Preserve the current description and screenshot inventory/order for the
   scoped fields. Reference this before-state in the evidence ledger. A mismatch
   with expected draft/version or an unexpected package upload stops writes.
3. Locate Store listing and the language selector by current labels. Map locale
   names/codes below; Chinese variants must not be swapped. If a locale is
   missing, inspect upload processing status and the **original checked ZIP**
   for `_locales/en`, `_locales/ko`, `_locales/ja`, `_locales/zh_CN`, and
   `_locales/zh_TW` plus `default_locale: en`. Wait/read again if processing is
   ongoing. If processing succeeded and catalogs are present but the locale
   remains absent, record the UI evidence and stop for diagnosis; do not upload
   again, change unrelated fields or fabricate a locale.
4. Select one locale. Paste only the text between `<!-- description:start -->`
   and `<!-- description:end -->` from its reviewed file. Omit markers and
   headings. Verify product name `GitHub Pulls Show Reviewers` and catalog-sourced
   short description; packaged metadata is not changed by the extension's UI
   language preference. Keep feature/privacy claims unchanged.
5. Compare current image previews/order to the approved manifest and recorded
   previous-release inventory before editing. Retain already-matching images.
   For an expected update, preserve the identified old images/order as before-state
   and replace those previous-release screenshots with the approved new three
   using supported controls. This ordinary replacement is covered by existing
   descriptions/screenshots authority; it needs no repeated approval. On resume,
   recognize a mix of known old and new images, replace only remaining old images,
   add missing new images and restore `01`, `02`, `03` order. Remove identifiable
   duplicate copies of the target images only as part of this scoped reconciliation.
   Do not blindly append/delete on reruns. If content cannot be identified or is
   outside the assigned inventory, preserve evidence and resolve the discrepancy
   before replacement/removal. Unexpected draft identity still stops all writes.
   Do not invent a
   dashboard caption field from the source inventory's scene descriptions.
6. Save the locale using the listing save control. **Saving text is distinct
   from Submit for review.** Navigate to a different locale/page and return;
   inspect the persisted detailed description and all three ordered previews.
   Compare the full text to the extracted source (only line-ending conversion
   may be normalized), and visually check correct language, readability,
   clipping and image order. Record discrepancies instead of marking ready.
   A click, save toast, or initial preview alone is not persistence evidence.
7. Repeat for all five locales. Leave unrelated privacy, distribution,
   visibility and pricing fields unchanged; raise an actual blocking requirement
   as a separate scope decision. Small and marquee promotional tiles are global,
   not five per-locale uploads. Saving these listings never includes clicking
   dashboard submit/publish/cancel or manually uploading a package.

All paths below are repository-relative; resolve them within the assigned
source to absolute paths for browser file upload. Each row uses files **01, 02,
03**, in this order: `01-pr-list-before-after.png`,
`02-pr-list-avatar-state-showcase.png`, `03-options-repository-check.png`.

| Locale / label intent | Detailed description | Directory containing its three images |
| --- | --- | --- |
| `en` / English | `docs/chrome-web-store-locales/en.md` | `docs/chrome-web-store-assets/` (no `en/` subdirectory) |
| `ko` / 한국어 / Korean | `docs/chrome-web-store-locales/ko.md` | `docs/chrome-web-store-assets/ko/` |
| `ja` / 日本語 / Japanese | `docs/chrome-web-store-locales/ja.md` | `docs/chrome-web-store-assets/ja/` |
| `zh_CN` / 简体中文 / Chinese (Simplified) | `docs/chrome-web-store-locales/zh_CN.md` | `docs/chrome-web-store-assets/zh_CN/` |
| `zh_TW` / 繁體中文 / Chinese (Traditional) | `docs/chrome-web-store-locales/zh_TW.md` | `docs/chrome-web-store-assets/zh_TW/` |

Use this evidence row once per locale. Keep the detailed ledger separate from
the strict listing-ready JSON; extra JSON fields will be rejected.

```text
locale: <en|ko|ja|zh_CN|zh_TW>; observed dashboard label: <label>
sourceSha / copy path / full-file SHA-256: <...>
extracted description SHA-256 (UTF-8, recorded line-ending convention): <...>
images: <ordered absolute source paths and each SHA-256 from capture-manifest.json>
before-state: <scoped text/image-order evidence reference and UTC>
actions: <retained/replaced/added/reordered images; description save; no unrelated edits>
save / navigated away / returned: <UTC timestamps and destination>
persisted full text comparison: <PASS or exact discrepancy>
persisted images 01/02/03: <each matching visual identity + correct order, evidence references>
result: <verified|incomplete|conflicting>; next action: <...>
```

Local hashes prove which files were selected; dashboard previews normally do
not expose image-byte hashes. Do not claim the remote image hash was verified.
Screenshots should cover task fields only. Store no credentials or account
sensitive regions. Publish sanitized evidence to the authorized same-repository
destination, or hand it off locally if posting is outside scope.

## Listing-ready JSON and separate submission

Immediately before submission, recheck the current item/draft, all five saved
locales and receipt/history continuity. Create `listing-ready.json` from the
**original upload** receipt. This is the exact strict shape in `evidenceSchema`;
the values below are synthetic examples, not release evidence:

```json
{
  "receiptRunId": "123456789",
  "sourceSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "zipSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "itemId": "hoocgjopdboeghdkfjlkngkkpbiljggk",
  "version": "1.16.0",
  "observedAt": "2026-09-04T08:00:00.000Z",
  "evidenceUrl": "https://github.com/hon454/github-pulls-show-reviewers/issues/154#issuecomment-123456789",
  "listingReady": true,
  "noInterveningUpload": true,
  "draftVersionVerified": true,
  "locales": ["en", "ko", "ja", "zh_CN", "zh_TW"]
}
```

`receiptRunId`, `sourceSha`, `zipSha256`, `itemId` and `version` must match the
original receipt. `observedAt` must be at/after the upload receipt timestamp,
not in the future and at most **one hour old when execution validates it**.
The URL must be a real, credential-free HTTPS permalink on `github.com` in this
same repository, with no query string, username or password. Use a stable
issue-comment or commit permalink containing the actual evidence; syntactically
valid JSON does not prove that the evidence exists or is true. Exactly the five
unique locale codes are required. Refresh observations/evidence if queueing and
build gates exhaust the hour; do not simply advance the timestamp.

The three `true` flags attest actual operator observations. They do not assert
that API status or local hashes prove the draft ZIP identity. For a known
`IN_PROGRESS` upload only, the optional additional field
`"asyncUploadConfirmed": true` attests fresh dashboard confirmation after the
API reports `lastAsyncUploadState: SUCCEEDED`. It does not recover `UNKNOWN`.
No other fields are accepted.

Only with existing explicit review-submission authority:

```bash
gh workflow run release.yml --repo hon454/github-pulls-show-reviewers \
  --ref main -f chrome_web_store=submit-existing \
  -f source_sha="$SOURCE_SHA" -f expected_version="$VERSION" \
  -f receipt_run_id="$UPLOAD_RUN_ID" \
  -F listing_evidence=@"$EVIDENCE_DIR/listing-ready.json"
```

Omit `tag`. The workflow reruns build gates, restores/verifies the original ZIP
and then performs **zero uploads**. Its one `publish` call uses
`skipReview: false`, `publishType: DEFAULT_PUBLISH`, `blockOnWarnings: true`:
normal review and automatic publication after approval, not deferred/staged
publication or skipped review. Keep both upload and submission run links,
results and listing-ready artifact. An unknown response is not success or a
safe retry signal. No raw credential/error payload belongs in the report.

## Resume and recovery examples

These are illustrative statuses, not live results. Reinspect state and receipt
history first; an old ledger is a resume hint, not current proof. Use a new
dispatch for an allowed next action, never rerun a mutating workflow attempt.
One item queue has `cancel-in-progress: false`; never cancel another operator's
run/review to clear it.

| Status example | Exact next action |
| --- | --- |
| Upload pending: original result `upload: IN_PROGRESS`, `outcome: UNCERTAIN`; no submit | Read-only status/dashboard observation. After API async SUCCEEDED plus fresh draft/listings and no intervening upload, use original receipt + `asyncUploadConfirmed: true` for authorized submit-existing. No reupload |
| Partial listing: en/ko reopened PASS, ja save interrupted, zh_CN/zh_TW untouched | Reopen en/ko to confirm continuity; reopen ja before retrying its save, retain persisted images, complete missing locales and record new proof |
| Ready without submit authority: five reopened PASS, draft verified | Report ready and original receipt/evidence; request only review-submission authority. Refresh all required observations if authority arrives after evidence expiry |
| Review pending: matching source receipt and `PENDING_REVIEW` at expected version | Report pending, zero further submission. Under separate tag authority, complete same-source GitHub Release; continue read-only publication observation |
| Rejected: submitted revision `REJECTED` / dashboard rejection | Preserve sanitized reason/current state; stop for reviewed remediation/version decision. Do not cancel, overwrite or resubmit automatically |
| Published: matching receipt/version `PUBLISHED` | Check public listing availability for all five locales and GitHub Release artifact/version; complete remaining authorized tag/report/closure work |
| UNKNOWN upload, missing result/intent, expired artifact or lost continuity | Preserve all evidence and stop for explicit recovery. API/local ZIP equality cannot establish a safe replacement upload |
| UNKNOWN submission, remote expected version pending/published | Report observed state without resubmitting. Workflow reuse still requires validated original upload or supported confirmed-submission history; otherwise stop |
| UNKNOWN submission, remote draft; wrong version/source/item; STAGED/CANCELLED/PUBLISHED_TO_TESTERS; warning/takedown | Stop for explicit recovery. No skip-review, cancellation or overwrite |

Async recovery depends on the public status field still being available; if it
cannot confirm success, stop. Do not turn an unknown outcome into success based
on a local artifact. See the [handoff recovery reference](./cws-agent-handoff.md#state-and-recovery-rules).

## Later tag and completion report

After confirmed staged submission and **separate tag authority**, verify the
tag does not exist and create it at the original reviewed upload `sourceSha`,
not today's main or a later documentation commit. Follow the authorized tag
procedure; never move existing tags. The push workflow requires the original
receipt/artifact and matching pending/published CWS state to reuse the ZIP with
no upload/submission. A new source without that receipt instead triggers the
ordinary automatic upload-and-submit path, so source choice is consequential.

Inspect the resulting GitHub Release and compare the downloadable inner ZIP's
hash with the original `package.zipSha256`. Record the release note from that
same source and public store version. A GitHub Release can exist while review
is pending; it is not proof of store publication. Do not close the release
issue/milestone until actual publication and required locale availability are
confirmed, under the assignment's closure authority.

```text
Release report (observedAt UTC): <...>
Repository / sourceSha / version / workflowSha / itemId: <...>
Scope authorized and exercised: <stages; submission/tag/closure authority>
Preflight: <PASS/gaps and evidence>
Upload: <state; original run URL; intent/result; artifact ID/name/outer digest; ZIP hash>
Locales en / ko / ja / zh_CN / zh_TW: <each persisted PASS/incomplete + ledger/permalink>
Draft continuity / listing-ready: <observations, timestamp, JSON/evidence; freshness>
Submission: <not authorized/not attempted/confirmed/unknown; run URL; result>
Store: <actual submitted version/state; actual published version/state; evidence>
Tag / GitHub Release / asset hash: <not created or exact ref/SHA/URL/hash>
Release issue / milestone: <open/closed and unmet acceptance>
Unresolved gaps and live operations not tested: <...>
Exact next action and owner: <one concrete step with any missing authority/prerequisite>
```

## Mock walkthrough validation

Run from a dependency-installed checkout:

```bash
pnpm exec vitest run tests/cws-agent-walkthrough.test.ts tests/release-policy.test.ts tests/release-provenance.test.ts tests/release-cws.test.ts
pnpm verify:cws
```

The walkthrough uses the real policy/engine and actual five copy files/15 image
paths with a test-only persisted dashboard model. It demonstrates normal
upload → five saved/reopened listings → submit → same-source pending/published
reuse, and expected prior-release image replacement, interruption after a save,
missing text/image persistence, absent
submission authority, async upload recovery, and unknown/rejected stops. It
checks action counts and policy rejection, rather than matching prose phrases.
The model is an exercise of the procedure, not a dashboard automation client or
proof of today's live UI. Existing provenance/adapter fixtures cover artifact
tampering and supported request behavior. **Live dashboard edits, CWS upload,
submission, cancellation, publication and tag/Release creation remain untested
by this documentation validation.** Do not perform them merely to test this file.
