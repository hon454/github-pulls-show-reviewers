import { describe, expect, it, vi } from "vitest";

import {
  fetchCanaryCoreQuota,
  LIVE_CANARY_MAX_QUOTA_WAIT_MS,
  LIVE_CANARY_QUOTA_RESET_GRACE_MS,
  LIVE_CANARY_RATE_LIMIT_URL,
  LIVE_CANARY_REQUIRED_QUOTA,
  parseCanaryCoreQuota,
  planCanaryQuota,
  waitForCanaryQuota,
  type CanaryCoreQuota,
} from "./helpers/live-github-canary-quota";

const nowMs = 1_794_846_000_000;
const resetInMs = (ms: number) => Math.floor((nowMs + ms) / 1000);

describe("live canary quota budget", () => {
  it("covers two fresh 25-row pages with a margin inside the 60/hour limit", () => {
    expect(LIVE_CANARY_REQUIRED_QUOTA).toBe(56);
    expect(LIVE_CANARY_REQUIRED_QUOTA).toBeLessThanOrEqual(60);
    expect(LIVE_CANARY_MAX_QUOTA_WAIT_MS).toBeGreaterThan(60 * 60_000);
  });
});

describe("planCanaryQuota", () => {
  const base = { nowMs, required: 56, remainingWaitMs: 60 * 60_000 };

  it("proceeds when the remaining quota covers a full attempt", () => {
    expect(
      planCanaryQuota({
        ...base,
        quota: { limit: 60, remaining: 56, reset: resetInMs(0) },
      }),
    ).toEqual({ action: "proceed" });
  });

  it("waits until just past the reset when the quota was partly spent (run 43900403604)", () => {
    expect(
      planCanaryQuota({
        ...base,
        quota: { limit: 60, remaining: 38, reset: resetInMs(30 * 60_000) },
      }),
    ).toEqual({
      action: "wait",
      waitMs: 30 * 60_000 + LIVE_CANARY_QUOTA_RESET_GRACE_MS,
    });
  });

  it("re-reads after the grace delay when the advertised reset already passed", () => {
    expect(
      planCanaryQuota({
        ...base,
        quota: { limit: 60, remaining: 0, reset: resetInMs(-10_000) },
      }),
    ).toEqual({ action: "wait", waitMs: LIVE_CANARY_QUOTA_RESET_GRACE_MS });
  });

  it("fails as environment when the wait would exceed the remaining bound", () => {
    expect(
      planCanaryQuota({
        ...base,
        remainingWaitMs: 60_000,
        quota: { limit: 60, remaining: 0, reset: resetInMs(10 * 60_000) },
      }),
    ).toEqual({ action: "fail", code: "api-quota-wait-exceeded" });
  });

  it("fails when even a full window cannot cover an attempt", () => {
    expect(
      planCanaryQuota({
        ...base,
        quota: { limit: 50, remaining: 10, reset: resetInMs(60_000) },
      }),
    ).toEqual({ action: "fail", code: "api-quota-limit-too-low" });
  });
});

describe("parseCanaryCoreQuota", () => {
  it("reads the core resource", () => {
    expect(
      parseCanaryCoreQuota({
        resources: {
          core: { limit: 60, remaining: 12, reset: 1794846193, used: 48 },
        },
        rate: { limit: 60, remaining: 12, reset: 1794846193 },
      }),
    ).toEqual({ limit: 60, remaining: 12, reset: 1794846193 });
  });

  it.each([
    null,
    {},
    { resources: {} },
    { resources: { core: { limit: "60", remaining: 1, reset: 1 } } },
    { resources: { core: { limit: 60, remaining: -1, reset: 1 } } },
    { resources: { core: { limit: 60, remaining: 1.5, reset: 1 } } },
  ])("rejects malformed body %#", (body) => {
    expect(parseCanaryCoreQuota(body)).toBeNull();
  });
});

describe("waitForCanaryQuota", () => {
  function harness(quotas: Array<CanaryCoreQuota | null | Error>) {
    let clock = nowMs;
    const readQuota = vi.fn(async () => {
      const next = quotas.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    });
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const onWait = vi.fn();
    return { readQuota, sleep, onWait, now: () => clock };
  }

  it("proceeds immediately without waiting", async () => {
    const h = harness([{ limit: 60, remaining: 60, reset: resetInMs(0) }]);
    const result = await waitForCanaryQuota(h);

    expect(result).toMatchObject({
      outcome: "proceed",
      failureCode: null,
      required: LIVE_CANARY_REQUIRED_QUOTA,
      waitedMs: 0,
    });
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it("waits for the reset, extends the deadline, then proceeds on a full window", async () => {
    const h = harness([
      { limit: 60, remaining: 38, reset: resetInMs(20 * 60_000) },
      { limit: 60, remaining: 60, reset: resetInMs(80 * 60_000) },
    ]);
    const result = await waitForCanaryQuota(h);
    const waitMs = 20 * 60_000 + LIVE_CANARY_QUOTA_RESET_GRACE_MS;

    expect(h.onWait).toHaveBeenCalledWith(waitMs);
    expect(h.sleep).toHaveBeenCalledWith(waitMs);
    expect(result.outcome).toBe("proceed");
    expect(result.waitedMs).toBe(waitMs);
    expect(result.observations.map((o) => o.plan.action)).toEqual([
      "wait",
      "proceed",
    ]);
  });

  it("charges repeated waits against one total bound", async () => {
    const stale = () => ({
      limit: 60,
      remaining: 0,
      reset: resetInMs(-1_000),
    });
    const h = harness(Array.from({ length: 10 }, stale));
    const result = await waitForCanaryQuota({ ...h, maxWaitMs: 12_000 });

    expect(result).toMatchObject({
      outcome: "fail",
      failureCode: "api-quota-wait-exceeded",
    });
    expect(h.sleep).toHaveBeenCalledTimes(2);
  });

  it.each([[null], [new Error("network")]])(
    "proceeds without a verdict when the quota is unreadable (%#)",
    async (quota) => {
      const h = harness([quota]);
      const result = await waitForCanaryQuota(h);

      expect(result.outcome).toBe("unreadable");
      expect(result.observations).toEqual([
        { atMs: nowMs, quota: null, plan: { action: "unreadable" } },
      ]);
      expect(h.sleep).not.toHaveBeenCalled();
    },
  );
});

describe("fetchCanaryCoreQuota", () => {
  it("sends an unauthenticated request to the free rate_limit endpoint", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            resources: { core: { limit: 60, remaining: 7, reset: 1 } },
          }),
          { status: 200 },
        ),
    );

    await expect(
      fetchCanaryCoreQuota(fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual({ limit: 60, remaining: 7, reset: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(LIVE_CANARY_RATE_LIMIT_URL);
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("returns null for a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    await expect(
      fetchCanaryCoreQuota(fetchImpl as unknown as typeof fetch),
    ).resolves.toBeNull();
  });
});
