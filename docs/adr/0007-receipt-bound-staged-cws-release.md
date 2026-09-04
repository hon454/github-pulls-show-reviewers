# ADR 0007: Separate CWS upload and submission with durable receipts

Status: accepted for implementation in #153

## Context

New CWS listing languages depend on the uploaded package's locale directories.
The previous release path uploaded and submitted immediately. Its tag-ref
condition also allowed manual skip/dry-run dispatches against a tag to publish.
CWS v2 status cannot prove the byte identity or reliably expose the version of
an unsubmitted draft. The public publishing SDK always uploads in `submit()`.

## Decision

Resolve event type and explicit dispatch action in a tested pure policy. Keep
new-version tag pushes automatic and dispatch default skip. Add upload-only and
submit-existing stages; neither creates a tag or GitHub Release. Credential-only
dry-run checks both authentication facilities without entering package/release
steps and is allowed on a reviewed PR branch before integration.

Separate trusted workflow control code from the exact package source. CWS
mutations require both commits on freshly fetched main plus production
preflight, full release verification and checked packaging. Save a durable
intent before any mutation and a sanitized result afterward. Verify original
package/run/artifact provenance through GitHub's API, including successful build
steps and artifact/zip digests. Serialize the item without cancellation and
inspect item-wide history, not only the current source.

Use the public SDK's skip-submit-review option for upload, with cancellation
disabled. Use Google's maintained public auth library and one non-retrying
native HTTP `publish` request for submit-existing. Require normal review and
automatic publication after approval. The operator must attest fresh dashboard
draft-version/listing checks for exactly five locales, tied to the original
receipt. Keep local artifact identity distinct from remote draft identity.

Repeated or uncertain operations read status before deciding. Confirmed
pending/published receipts are no-ops. Conflicts and missing evidence stop for a
recovery decision. Explicit async recovery can proceed after status confirms
success and fresh dashboard evidence identifies the draft; unknown timeouts do
not automatically authorize another write. Later tags of the exact staged
source reuse the original zip and create GitHub release artifacts without
another CWS submission.

## Consequences

Listing registration can finish between jobs without retaining a runner. Extra
artifact validation and separate source builds add release-time work but do not
affect extension runtime behavior, auth storage, or public no-token support.
Workflow serialization cannot lock out a dashboard operator; the handoff
requires exclusive package ownership. Artifacts are retained for 90 days, so
the staged handoff/tag must finish before expiry; missing provenance requires
explicit recovery. The [runbook](../cws-agent-handoff.md) defines exact inputs and
states. Real credential-only validation is required after publishing changes;
production mutation is not a validation technique.
