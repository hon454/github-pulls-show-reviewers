/**
 * Unauthenticated REST quota gate for the live canary.
 *
 * The extension reads public reviewers without a token, so the canary shares
 * the runner IP's 60-requests-per-hour core quota with whatever used that IP
 * earlier. A complete A→D attempt freshly fetches two pull-list pages (one
 * list request plus one reviews request per row each); later stages are
 * largely served from the browser HTTP cache. Starting with less quota than
 * that turns an unrelated earlier job into a canary failure, so each attempt
 * first waits — boundedly — until the quota can cover a full attempt.
 *
 * `GET /rate_limit` does not consume core quota and is not oracle evidence: it
 * never informs the reviewer verdict.
 */

export const LIVE_CANARY_ROWS_PER_PAGE = 25;
export const LIVE_CANARY_FRESH_PAGES = 2;
export const LIVE_CANARY_QUOTA_MARGIN = 4;
/** Fresh pages × (one list + one reviews request per row) + margin. */
export const LIVE_CANARY_REQUIRED_QUOTA =
  LIVE_CANARY_FRESH_PAGES * (1 + LIVE_CANARY_ROWS_PER_PAGE) +
  LIVE_CANARY_QUOTA_MARGIN;
/** Covers one full hourly reset window plus clock skew. */
export const LIVE_CANARY_MAX_QUOTA_WAIT_MS = 62 * 60_000;
/** Delay past the advertised reset before re-reading the quota. */
export const LIVE_CANARY_QUOTA_RESET_GRACE_MS = 5_000;

export const LIVE_CANARY_RATE_LIMIT_URL = "https://api.github.com/rate_limit";

export type CanaryCoreQuota = {
  limit: number;
  remaining: number;
  /** Epoch seconds. */
  reset: number;
};

export type CanaryQuotaPlan =
  | { action: "proceed" }
  | { action: "wait"; waitMs: number }
  | {
      action: "fail";
      code: "api-quota-limit-too-low" | "api-quota-wait-exceeded";
    };

export function planCanaryQuota(input: {
  quota: CanaryCoreQuota;
  nowMs: number;
  required: number;
  remainingWaitMs: number;
}): CanaryQuotaPlan {
  const { quota, nowMs, required, remainingWaitMs } = input;
  if (quota.remaining >= required) return { action: "proceed" };
  if (quota.limit < required)
    return { action: "fail", code: "api-quota-limit-too-low" };
  const waitMs =
    Math.max(0, quota.reset * 1000 - nowMs) + LIVE_CANARY_QUOTA_RESET_GRACE_MS;
  if (waitMs > remainingWaitMs)
    return { action: "fail", code: "api-quota-wait-exceeded" };
  return { action: "wait", waitMs };
}

export function parseCanaryCoreQuota(body: unknown): CanaryCoreQuota | null {
  const core = (body as { resources?: { core?: unknown } } | null)?.resources
    ?.core as Record<string, unknown> | undefined;
  if (core == null) return null;
  const { limit, remaining, reset } = core;
  if (
    !isNonNegativeInteger(limit) ||
    !isNonNegativeInteger(remaining) ||
    !isNonNegativeInteger(reset)
  )
    return null;
  return { limit, remaining, reset };
}

export type CanaryQuotaObservation = {
  atMs: number;
  quota: CanaryCoreQuota | null;
  plan: CanaryQuotaPlan | { action: "unreadable" };
};

export type CanaryQuotaGateResult = {
  outcome: "proceed" | "unreadable" | "fail";
  failureCode: Extract<CanaryQuotaPlan, { action: "fail" }>["code"] | null;
  required: number;
  waitedMs: number;
  observations: CanaryQuotaObservation[];
};

export async function waitForCanaryQuota(input: {
  readQuota: () => Promise<CanaryCoreQuota | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Called before each wait so the caller can extend its own deadline. */
  onWait?: (waitMs: number) => void;
  required?: number;
  maxWaitMs?: number;
}): Promise<CanaryQuotaGateResult> {
  const required = input.required ?? LIVE_CANARY_REQUIRED_QUOTA;
  const maxWaitMs = input.maxWaitMs ?? LIVE_CANARY_MAX_QUOTA_WAIT_MS;
  const startedMs = input.now();
  const observations: CanaryQuotaObservation[] = [];
  const result = (
    outcome: CanaryQuotaGateResult["outcome"],
    failureCode: CanaryQuotaGateResult["failureCode"] = null,
  ): CanaryQuotaGateResult => ({
    outcome,
    failureCode,
    required,
    waitedMs: input.now() - startedMs,
    observations,
  });

  for (;;) {
    const quota = await input.readQuota().catch(() => null);
    const atMs = input.now();
    if (quota == null) {
      // Quota is diagnostic only; an unreadable endpoint must not become a
      // new failure source, so the attempt proceeds and the verdict decides.
      observations.push({ atMs, quota, plan: { action: "unreadable" } });
      return result("unreadable");
    }
    const plan = planCanaryQuota({
      quota,
      nowMs: atMs,
      required,
      remainingWaitMs: maxWaitMs - (atMs - startedMs),
    });
    observations.push({ atMs, quota, plan });
    if (plan.action === "proceed") return result("proceed");
    if (plan.action === "fail") return result("fail", plan.code);
    input.onWait?.(plan.waitMs);
    await input.sleep(plan.waitMs);
  }
}

export async function fetchCanaryCoreQuota(
  fetchImpl: typeof fetch = fetch,
): Promise<CanaryCoreQuota | null> {
  const response = await fetchImpl(LIVE_CANARY_RATE_LIMIT_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "github-pulls-show-reviewers-live-canary",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  return parseCanaryCoreQuota(await response.json());
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
