# ADR 0009: Bounded repository account discovery

- Status: Accepted — policy 1A in #176
- Date: 2026-09-08
- Builds on: [background credentials](./0008-background-credentials-and-ui-capabilities.md) and [credential generations](./0004-github-app-token-refresh.md)

## Context

GitHub App user access is the intersection of the App installation's coverage
and the user's repository permissions. Two connected accounts can both have an
`all` organization installation while only the second can read one repository.
The deterministic initial resolver previously stopped at the first account's 404. An owner-wide fallback hint cannot represent that permission difference.

## Decision

Keep initial resolution and bounded installation self-healing. After a proven
non-rate-limited authenticated repository 403/404, serially try eligible active
same-owner accounts: locally covered first, truncated selected snapshots second,
in existing account order within each tier. Deduplicate account IDs and recheck
registry/auth/coverage before dispatch and before accepting results. Complete
selected misses require updated self-heal evidence. Never enumerate all
repositories upfront or probe unrelated accounts.

Classify every unresolved failure before advancing. Rate-limit signals, remaining
401, network/schema/5xx/cancellation/unknown stop the chain. The existing refresh
coordinator may recover that same account's 401; no second coordinator is added.
A repository metadata success, including an empty list, separates PR-specific
errors from repository denial. Both metadata and reviewer summaries return the
actual safe account/revision used, and caches preserve that identity.

One background service owns shared discovery for each browser document,
repository and explicit generation. Before HTTP, its short persistence queue
reserves every distinct candidate in trusted session storage. HTTP never holds
the registry or ledger queue. Session records contain no credentials or full
repository inventories. Successful associations are ephemeral, not permanent
repository settings. Independent diagnostics uses the same policy with its own
explicit run identity; anonymous diagnostics never picks a connected account.

Worker restoration preserves the admission bound. Confirmed denial can continue
with an unattempted eligible candidate. Stop/exhaustion is terminal; an admitted
unknown dispatch becomes interrupted. Missing/retired identities fail closed,
using a per-document generation high-water mark to prevent replay. New explicit
generations replace old bodies. Verified document loss prunes both; content
liveness uses a document-targeted message because Chrome `getContexts` does not
list content documents. Ordinary disconnect or a frozen/unresponsive tab keeps
its records.

Each joined caller has an independent cancellation subscription. The last
consumer or generation cancellation aborts shared work without refunding an
admission. Content's four-slot summary FIFO remains bounded and cannot wait on
new discovery that itself needs a row slot. The aggregate access banner receives
only final row results. Language/display changes remain render-only.

Token rotation and terminal credential invalidation are distinguished from
reconnection, removal and installation changes. Rotation updates safe summaries
without opening another discovery wave. Invalidation cancels obsolete row work
while retaining the original 401 stop. Reload/navigation, force refresh and
changed account access evidence can explicitly create a new generation.

## Consequences and alternatives

The first denied repository may require several serial metadata probes, bounded
by distinct eligible accounts. Later rows share the result. We accept the small
session ledger to preserve this bound over worker suspension. An interrupted
unknown request needs an explicit retry trigger; it is never guessed to be a
denial. There are no quota bypasses, retry timers, new permissions or review-state
changes.

A manual binding UI and persistent repository mappings were excluded by policy
1A. Owner-wide hints, one fallback per row and an in-memory-only attempt set
cannot provide the selected permission semantics and lifecycle guarantees.

See [implementation notes](../implementation-notes.md#bounded-repository-account-discovery)
for exact contracts and regression suites, and
[manual Chrome testing](../manual-chrome-testing.md#multi-account-repository-fallback)
for synthetic native verification.
