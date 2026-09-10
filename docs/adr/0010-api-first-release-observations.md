# ADR 0010: API-first release observations and saved-listing reuse

## Status

Proposed in #211 for v1.18.2.

## Context

Ordinary package releases were treated as localized listing registrations,
requiring browser access and repeated dashboard checks even when descriptions
and screenshots had not changed. Credential-only dry-run discarded its API
response and could not explain pending review, publication, receipt provenance
or the next operational action.

CWS status does not identify remote draft bytes or saved listing content.
Removing every dashboard check would make unverifiable claims about those
facts. Creating another mutation policy for a status command would also risk
drifting away from the guarded write path.

## Decision

Expose an explicit `status` action in a separate job with read-only GitHub
permissions. Reuse the CWS adapter, trusted receipt/package readers, and shared
readiness checks with guarded execution. Emit schema-validated, sanitized JSON
and Actions Summary. Keep observed publication separate from submitted review;
leave remote draft existence, version and ZIP hash unknown. Reports never
authorize a release or replace fresh validation before later mutations.
Give status its own item queue so it cannot replace a pending mutation. Preserve
the existing mutation key in the package job across workflow versions. Concurrent
observations with incomplete provenance remain blocked until a fresh read can
establish the evidence.

Store reviewed saved-content attestations in
`docs/chrome-web-store-listing-baseline.json` on `main`, independently of a
particular package version. Bind five saved/reopened locale records to actual
evidence permalinks, a reviewed source SHA, description-file hashes and three
ordered image hashes per locale. Validate the baseline against its own source
before comparing exact description-marker contents and ordered images at the
requested release source. Share strict description extraction with `verify:cws`;
retain whole-file hashes for provenance and ignore contributor-only changes
outside the markers. Do not add a successful baseline
without real observations. See the [contract](../chrome-web-store-listing-baseline.md).

Ordinary unchanged listings reuse that evidence through API/receipt readiness.
Changed listings for unsubmitted packages keep the staged upload/edit/submit-existing
procedure. Verified pending/published package reuse remains independent of
listing work, which is explicitly reported in `listing.nextAction`. Pending
review must finish without cancellation before listing edits; published
packages require scoped listing work without reupload. Missing,
invalidated or conflicting evidence requires targeted reconciliation. Dashboard
access is required only for a specifically identified fact unavailable through
the API, including some draft-continuity and policy-warning details.

## Consequences

- Existing checked packaging, receipt provenance, main ancestry, serialization,
  normal review, manual `skip` default and credential-only `dry-run` remain.
- Status may download a prior package for validation but cannot create an
  extension package, upload, submit, mutate tags or change GitHub Releases.
- A completed status workflow can report blockers; observation success is not
  release readiness. The report names the next observation, wait, scoped UI
  check or explicit recovery decision.
- A baseline has no arbitrary expiry tied to package versions. Operators must
  invalidate it after contradictory evidence or intervening listing edits;
  the API cannot detect unrecorded dashboard edits.
- Maintainer review of the actual evidence remains necessary. JSON flags and
  local hashes cannot independently prove saved remote content, and the
  reusable baseline cannot replace fresh draft-bound submission evidence.
- The implementation adds no release tag, version bump or production write.
