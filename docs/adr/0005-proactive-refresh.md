# ADR 0005: Proactive Access Token Refresh via chrome.alarms

- Status: Accepted — extends [ADR 0004](./0004-github-app-token-refresh.md) with a proactive refresh path
- Date: 2026-04-24

## Context

[ADR 0004](./0004-github-app-token-refresh.md) made 8-hour access-token expiry
invisible by exchanging a stored `refresh_token` inside the MV3 service worker
the moment a reviewer fetch hits 401. Two gaps remained:

- The unlucky first row after expiry still paid the refresh round-trip in the
  user's view.
- Access tokens that expired while no GitHub tab was open were never refreshed
  until the user browsed back to a PR list.

`chrome.alarms` persists registrations across MV3 service-worker activations,
so a recurring alarm can drive refreshes independently of tab state and close
both gaps.

## Decision

Register a single recurring alarm that pre-warms soon-to-expire access tokens
and drops terminal accounts early.

- `src/config/proactive-refresh.ts` exports
  `PROACTIVE_REFRESH_ALARM_NAME`, `PROACTIVE_REFRESH_PERIOD_MINUTES = 15`, and
  `PROACTIVE_REFRESH_THRESHOLD_MS = 30 * 60 * 1000`. Threshold exceeds the
  period so no expiry window slips between fires.
- `src/background/proactive-refresh.ts` exposes two pure selectors —
  `selectAccountsDueForRefresh` and `selectAccountsWithExpiredRefreshToken` —
  plus `createProactiveRefreshService` that schedules the alarm and routes
  eligible accounts through the shared refresh coordinator.
- Accounts whose `refreshTokenExpiresAt` is already in the past are not sent
  to the coordinator; the proactive path calls `markAccountInvalidated(id,
  "expired")` directly because the refresh network call is guaranteed to fail.
- `entrypoints/background.ts` wires the service, schedules the alarm on every
  SW boot (`scheduleAlarm` guards against SW-restart resets by calling
  `browser.alarms.get` and skipping re-creation when the existing period
  matches), and routes `browser.alarms.onAlarm` into the handler.
- The `alarms` manifest permission is added via `wxt.config.ts`.

Refresh dispatch uses `Promise.allSettled` so one account's failure does not
abort others. The shared in-flight dedupe in
`src/auth/refresh-coordinator.ts` prevents thundering-herd refreshes when
proactive and reactive paths race.

## Rationale

- First-row refresh latency is eliminated for the common case: tokens are
  refreshed 30 minutes before expiry, well before any reviewer fetch triggers
  reactive retry.
- Closed-tab expiry is covered because the alarm wakes the SW on its own.
- Accounts with a terminal refresh-token failure surface "sign in again" in
  the options UI without waiting for a user action, removing a silent dead-
  account class.
- The reactive refresh path remains the safety net, so a missed or truncated
  proactive fire does not break the first reviewer row.

## Alternatives considered

- **Per-account alarms (structurally ideal for MV3)** — register one alarm
  per account so each fire handles exactly one account in a single network
  call, guaranteed to finish within the ~30s SW-alive window. Eliminates a
  class of timing risk by construction. Rejected **for now** because the
  extra complexity (alarm/account lifecycle sync, naming scheme) is not
  justified at current product scale (small number of connected accounts per
  user). See *Revisit trigger* below.

- **Service-worker keepalive workarounds** — repeated port reconnects,
  periodic `chrome.runtime.getPlatformInfo()` calls, or ping loops to stretch
  SW life during a multi-account `Promise.allSettled`. Rejected because
  `alarms.onAlarm` has no official lifetime extension for async work and
  these workarounds are routinely broken by Chrome updates, carrying high
  maintenance cost.

## Consequences

### Positive

- Users stop paying the reactive refresh round-trip on the first row after
  each 8-hour expiry window.
- Access tokens expiring while every GitHub tab is closed still get refreshed
  from background, so re-opening a PR list is instant again.
- Terminal refresh-token failures surface promptly without a failed network
  call every 15 minutes.

### Negative

- Known limitation: `browser.alarms.onAlarm` listeners do not extend
  service-worker lifetime for async work. `handleAlarmFire` completes
  multiple refreshes via `Promise.allSettled`; at current product scale (few
  accounts, fast refresh endpoint) the work fits comfortably inside the ~30s
  SW-alive window after the event, but this is not a structural guarantee.
  A truncated run is bounded-harm: the reactive refresh path still serves as
  the safety net, and the next 15-minute alarm retries.

### Neutral

- Adds the `"alarms"` manifest permission. Existing installs receive it on
  extension update; Chrome does not disable the extension for adding
  `"alarms"`. `host_permissions` are unchanged.
- Adds one `listAccounts` read per 15-minute fire and up to one refresh
  request per eligible account per fire. Coordinator dedupe absorbs races
  with reactive refreshes.

## Revisit trigger

The "5 accounts" threshold below is not arbitrary: at an empirical
refresh-endpoint latency of ~1–2s per account, a single fire with 5 eligible
accounts consumes ~5–10s of the ~30s SW-alive window (roughly one-third).
Beyond that, the margin for storage writes and one-off stalls shrinks fast,
and the three triggers below start correlating (account count → per-fire
time → observed failures).

Move to per-account alarms (new ADR superseding this one) if any of the
following is observed:

- Active account count on typical installs reaches 5 or more, so a single
  fire increasingly risks exceeding the SW-alive window.
- Proactive refresh failures or missed runs are observed in practice.
- Average single-fire execution time crosses ~10 seconds.

Until one of those triggers fires, the single-alarm design is retained.

## Links

- [ADR 0004](./0004-github-app-token-refresh.md) — this ADR extends its
  reactive refresh path.
- `src/config/proactive-refresh.ts`
- `src/background/proactive-refresh.ts`
- `entrypoints/background.ts` — alarm wiring
