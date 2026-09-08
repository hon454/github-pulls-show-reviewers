# ADR 0008: Background credentials and token-free UI capabilities

- Status: Accepted — policy 2B in #175
- Date: 2026-09-08
- Amends: [Device Flow](./0003-github-app-device-flow.md), [token refresh](./0004-github-app-token-refresh.md), [proactive refresh](./0005-proactive-refresh.md), and [localization](./0006-bundled-localization-and-render-only-language.md)

## Context

Content account resolution, options account loading and device sign-in previously
used credential-bearing accounts. Options also subscribed to global storage
changes, whose payloads could contain auth records even when callbacks ignored
those keys. Moving just HTTP or restricting just content storage does not satisfy
the selected policy: neither UI may read, receive or retain access tokens,
refresh tokens or OAuth device-code secrets. This is architectural hardening;
no host-page token theft was demonstrated.

## Credential and storage ownership

Background owns OAuth initiation/polling, authenticated API requests, full
accounts, legacy migration and credential writes. `accountMutations` remains
the sole registry/init/repair/normalized-login identity and auth commit owner
from #166. Device flow reuses it; it does not allocate a second canonical login
identity. Network requests stay outside that short queue. The same
generation-aware refresh coordinator serves reviewer, diagnostics, installation
and proactive-refresh operations.

`createStoragePolicy` restricts local and session areas to `TRUSTED_CONTEXTS`
before initialization and sensitive operations, on each worker activation. A
failed gate returns `unavailable` without proceeding and can retry later.
Persistent v4 accounts, refresh tokens and version-1 preferences stay in local
storage; migration preserves existing accounts and valid display/language fields.

Chrome excludes content scripts from trusted storage, including direct reads and
writes. Chrome considers options a trusted extension page. Token-free options is
therefore an application contract enforced by module boundaries, schemas, tests
and review; it is not an OS/profile encryption guarantee or a separate Chrome
background-only permission. No UI code reads local storage or listens to raw
`storage.onChanged`. No protection from arbitrary code already executing inside
a trusted extension page is claimed.

## Capabilities and caller identity

`src/runtime/ui-contract.ts` defines strict requests, `AccountSummary`, progress,
snapshots and events. `src/background/account-summary.ts` explicitly projects
ID/login/avatar, validity/reason, opaque credential revision, installation owner
labels and refresh timestamp. Repository inventories, tokens and auth fragments
are excluded. Results and nested diagnostic/reviewer evidence are schema parsed;
raw HTTP error prose, headers, response bodies and storage old/new records are
never forwarded. Technical statuses and rate-limit scalars remain available for
localized presentation. Full `Account` and credential-accepting helpers stay in
background application paths.

The bridge checks extension ID, a browser-supplied document ID, and sender URL.
Options requires the extension's exact `/options.html` URL. Content requires a
top-level `https://github.com` tab, and repository operations must match that
sender's owner/repository path. Missing/unrecognized contexts fail closed.

| Caller  | Allowed operations                                                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Options | Safe account/preferences snapshot, preference patch, account resolution, local removal, installation refresh, matched/anonymous diagnostics, own device-flow start/poll/cancel, open options    |
| Content | Preferences plus account revision snapshot, repository-bound account/fallback resolution, reviewer summary/metadata fetch and cancellation, repository-bound installation refresh, open options |

Content installation refresh additionally requires an active existing account
with an installation on the repository owner. It cannot start login, poll/cancel
another document's flow, remove accounts, change preferences, or run options
diagnostics. Reviewer cancellation IDs are namespaced by document. There is no
raw-token refresh endpoint, generic fetch proxy, arbitrary URL or storage-key
operation. Existing selection/fallback semantics remain unchanged; policy 1A is
separate work in #176.

## Device-flow ordering and restoration

Options creates an attempt ID before its first initiation request. Background
assigns an opaque flow ID and binds both to the originating document. Options
holds only the user verification code/link, deadline, interval and structured
progress. Its existing timer requests one eligible poll; background deduplicates
concurrent requests and enforces `nextPollAt`. A `slow_down` response adds at
least five seconds. No background polling loop, heartbeat, keepalive or new alarm
is introduced.

Trusted `storage.session` holds minimal flow records, including the device-code
secret while waiting. Access and refresh tokens from a successful exchange remain
in the background operation and then persistent account storage; they are not
flow progress or session snapshots sent to UI.

One flow owner queue orders start, cancel and final commit admission. HTTP and
the actual registry commit promise do not hold that queue. Cancel can arrive
before initiation and persist a non-secret tombstone. A successful cancellation
ACK means that attempt cannot admit a later account commit. Once commit is
admitted, cancellation returns `committing` or `connected`, and options waits for
the real outcome. It does not falsely report cancellation or delete a committed
account. Completion returns the actual stored account ID. Account notifications
follow the successful storage commit. Late results cannot close or advance a
newer panel; language changes retain the controller and current callback.

| Restored state                | Behavior                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Waiting                       | Preserve flow ID, original deadline, slowdown interval and next eligible tick                                                                       |
| Expired                       | Clear secret fields, return expired, issue no new OAuth request                                                                                     |
| Initiating or polling         | Clear secrets, return `restart_required`; the interrupted exchange is not replayed                                                                  |
| Committing                    | Match the opaque `connectionAttemptId` stored atomically with the account; return the committed identity when present, otherwise `restart_required` |
| Connected or cancelled        | Return terminal state without another commit/exchange                                                                                               |
| Missing after browser restart | Return `restart_required` and offer a new code; durable accounts remain saved                                                                       |

Cancellation, expiry, completion and detected owner loss scrub secret fields.
`runtime.getContexts`, when available, confirms document loss; an ordinary port
disconnect alone does not prove the document closed. Without that optional API,
explicit UI cancel/unmount and deadline expiry remain the fallback. There is no
new declared Chrome minimum. Flow entrypoints and worker activation prune
expired/abandoned entries; no periodic expiry job is added. Tombstones reject old
retries while the document exists, and session records disappear on browser
restart. Persistence failures fail closed before new HTTP/commit admission.

The account receipt prevents replay of an already durable connection; it does
not guarantee worker lifetime or recover credentials if GitHub rotated them but
the process stopped before durable storage. That pre-existing refresh rotation
window remains.

## Safe snapshots, events and preference writes

`createUIStateService` owns the raw background storage listener. It subscribes
before the initial read, then publishes allowlisted snapshots with a random
worker epoch and monotonically increasing revision. An opaque account digest
covers identity, credential revision/validity and installation coverage. Options
gets account summaries; content gets only that digest and preferences. Account
and coverage changes invalidate existing page decisions/caches; language and
display fields rerender existing presentations without altering requests,
failures, queue order or generation.

One `UIClient` per document shares a runtime port and rejects older snapshots or
responses. Reconnection obtains a fresh epoch/snapshot; old connection callbacks
cannot overwrite it. There are no port pings. Last unsubscribe/teardown releases
listeners, ports, pending reads and reconnect timers. Locale and options adapters
use this same boundary. Initial reads and delayed preference/account RPC results
cannot overwrite later committed notifications.

`patchPreferences` accepts only the existing optional language/display fields.
The background preference owner serializes read/merge/write against the latest
stored preferences. Different-field changes from two options pages preserve both;
same-field changes follow admitted order. Only successful writes produce changed
snapshots. A failed write rejects without poisoning subsequent updates. Auth HTTP
never uses this queue. There is no general storage transaction/proxy API.

Snapshots go only to authorized subscribed documents. Device progress goes only
to the owning document. Diagnostics and repository results are request replies;
they are not broadcast to unrelated GitHub tabs.

## Verification and follow-up contract

Real bridge/service tests use synthetic secret sentinels in stored accounts,
OAuth responses, nested errors and storage events. Coverage includes sender and
flow authorization, cancellation at each asynchronous boundary, commit admission,
restoration/expiry, persistence failures, account registry races and two-client
preference concurrency. UI tests cover delayed snapshots/replies, reconnects,
teardown and render-only locale/display updates.

Packaged Chromium tests exercise actual content storage denial, mocked sign-in,
diagnostics and installation refresh with service-worker request provenance,
`ServiceWorker.stopWorker` between ticks, and v3/v4 synthetic profile upgrades
using the same profile and extension ID. These are automated native browser
checks, not a claim of live GitHub sign-in, Chrome Web Store rollout or arbitrary
manual platform coverage.

#176 consumes `AccountSummary`, background account resolution/diagnostics,
existing generation-aware services and the account-change digest. #171 may use
the stable options controller (`start`, async `cancel`, structured phases and
actual-account completion) for later clipboard/focus work. Neither policy nor
that UI work is implemented here.
