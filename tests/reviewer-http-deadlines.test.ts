import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewerFetchService } from "../src/background/reviewer-fetch";
import { createRefreshCoordinator } from "../src/auth/refresh-coordinator";
import { createStorageHarness, deferred, json } from "./helpers/auth-harness";
import { REVIEWER_DEADLINES } from "../src/shared/reviewer-deadline";

const metadata = {
  number: "42",
  authorLogin: "author",
  requestedUsers: [],
  requestedTeams: [],
};
const summaryMessage = {
  type: "fetchPullReviewerSummary" as const,
  requestId: "summary-42",
  owner: "acme",
  repo: "widgets",
  pullNumber: "42",
  accountId: null,
  pullMetadata: metadata,
};
const metadataMessage = {
  type: "fetchPullReviewerMetadataBatch" as const,
  requestId: "metadata",
  owner: "acme",
  repo: "widgets",
  accountId: null,
  targetPullNumbers: ["42"],
};
const timeout = {
  ok: false,
  error: {
    status: null,
    failures: [{ kind: "timeout", status: null, rateLimited: false }],
  },
};
const never = () => new Promise<Response>(() => {});
let service: ReturnType<typeof createReviewerFetchService>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("browser", {
    storage: { local: createStorageHarness().local },
  });
  service = createReviewerFetchService({
    refreshCoordinator: createRefreshCoordinator({
      getClientId: () => "fixture",
    }),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mandatory reviewer HTTP deadlines", () => {
  it.each(["metadata", "summary"] as const)(
    "aborts stalled %s fetch and ignores late results",
    async (kind) => {
      const gate = deferred<Response>();
      let owned!: AbortSignal;
      const fetch = vi.fn((_url: string, init: RequestInit) => {
        owned = init.signal!;
        return gate.promise;
      });
      vi.stubGlobal("fetch", fetch);
      const work =
        kind === "summary"
          ? service.handleFetchMessage(summaryMessage)
          : service.handleMetadataBatchMessage(metadataMessage);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(owned.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await work).toMatchObject(timeout);
      expect(owned.aborted).toBe(true);
      gate.resolve(json([]));
      await vi.advanceTimersByTimeAsync(0);
      expect(await work).toMatchObject(timeout);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    "metadata",
    "summary",
    "error-body",
    "metadata-error-body",
  ] as const)("bounds %s JSON after response headers", async (kind) => {
    const body = deferred<unknown>();
    const response = json([], kind.endsWith("error-body") ? 401 : 200);
    vi.spyOn(response, "json").mockImplementation(() => body.promise);
    const fetch = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetch);
    const work = kind.startsWith("metadata")
      ? service.handleMetadataBatchMessage(metadataMessage)
      : service.handleFetchMessage(summaryMessage);
    await vi.advanceTimersByTimeAsync(REVIEWER_DEADLINES.summary);
    expect(await work).toMatchObject(timeout);
    body.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["metadata", "summary"] as const)(
    "does not restart %s deadline for a later page",
    async (kind) => {
      const first = deferred<Response>();
      const second = deferred<Response>();
      const fetch = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      vi.stubGlobal("fetch", fetch);
      const work =
        kind === "summary"
          ? service.handleFetchMessage(summaryMessage)
          : service.handleMetadataBatchMessage(metadataMessage);
      await vi.advanceTimersByTimeAsync(20_000);
      const response = json([]);
      const path = kind === "summary" ? "/pulls/42/reviews" : "/pulls";
      response.headers.set(
        "Link",
        `<https://api.github.com/repos/acme/widgets${path}?page=2>; rel="next"`,
      );
      first.resolve(response);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await work).toMatchObject(timeout);
      second.resolve(json([]));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds both unbatched endpoints even if one never answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(never));
    const work = service.handleFetchMessage({
      type: "fetchPullReviewerSummary",
      requestId: "unbatched",
      owner: "acme",
      repo: "widgets",
      pullNumber: "42",
      accountId: null,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await work).toMatchObject(timeout);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves external cancellation and cleans the deadline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(never));
    const work = service.handleFetchMessage(summaryMessage);
    await vi.advanceTimersByTimeAsync(1);
    service.cancelRequest(summaryMessage.requestId);
    expect(await work).toMatchObject({
      ok: false,
      error: { failures: [{ kind: "cancellation" }] },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("returns the first four summary slots at 30s and only then starts the other four", async () => {
  const { createAbortAwareRequestScheduler } =
    await import("../src/features/reviewers/request-scheduler");
  const scheduler = createAbortAwareRequestScheduler(4);
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      const number = Number(new URL(url).pathname.split("/").at(-2));
      started.push(number);
      active++;
      peak = Math.max(peak, active);
      if (number <= 4) {
        init.signal!.addEventListener("abort", () => active--, { once: true });
        return never();
      }
      active--;
      return Promise.resolve(json([]));
    }),
  );
  const tasks = Array.from({ length: 8 }, (_, index) =>
    scheduler.run(
      () =>
        service.handleFetchMessage({
          ...summaryMessage,
          requestId: `fifo-${index + 1}`,
          pullNumber: String(index + 1),
        }),
      new AbortController().signal,
    ),
  );
  await vi.advanceTimersByTimeAsync(29_999);
  expect(started).toEqual([1, 2, 3, 4]);
  expect(vi.getTimerCount()).toBe(4);
  await vi.advanceTimersByTimeAsync(1);
  const results = await Promise.all(tasks);
  expect(started).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(peak).toBe(4);
  expect(active).toBe(0);
  for (const result of results.slice(0, 4))
    expect(result).toMatchObject(timeout);
  for (const result of results.slice(4)) expect(result.ok).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

describe("optional events inherit the mandatory operation lifetime", () => {
  const ambiguous = {
    ...summaryMessage,
    pullMetadata: {
      ...metadata,
      requestedUsers: [{ login: "alice", avatarUrl: null }],
    },
  };
  const completed = [
    {
      state: "APPROVED",
      submitted_at: "2026-09-01T00:00:00Z",
      user: { login: "alice" },
    },
  ];

  it.each(["fetch", "body", "second-page"])(
    "limits optional %s to a total 10s without failing completed reviews",
    async (stage) => {
      const eventSignal: AbortSignal[] = [];
      const first = deferred<Response>();
      const body = deferred<unknown>();
      let events = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init: RequestInit) => {
          if (_url.includes("/reviews"))
            return Promise.resolve(json(completed));
          eventSignal.push(init.signal!);
          events++;
          if (stage === "fetch") return first.promise;
          if (stage === "second-page")
            return events === 1 ? first.promise : never();
          const response = json([]);
          vi.spyOn(response, "json").mockReturnValue(body.promise);
          return Promise.resolve(response);
        }),
      );
      const work = service.handleFetchMessage(ambiguous);
      await vi.advanceTimersByTimeAsync(7_000);
      if (stage === "second-page") {
        const response = json([]);
        response.headers.set(
          "Link",
          '<https://api.github.com/repos/acme/widgets/issues/42/events?page=2>; rel="next"',
        );
        first.resolve(response);
      }
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await work).toMatchObject({
        ok: true,
        summary: {
          status: "ok",
          completedReviews: [{ login: "alice", state: "APPROVED" }],
        },
      });
      expect(eventSignal.every((signal) => signal.aborted)).toBe(true);
      expect(events).toBe(stage === "second-page" ? 2 : 1);
      first.resolve(json([]));
      body.resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([20_000, 25_000])(
    "does not swallow the upper timeout when events start at %sms",
    async (reviewsDelay) => {
      const reviewGate = deferred<Response>();
      const eventGate = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string) =>
          _url.includes("/reviews") ? reviewGate.promise : eventGate.promise,
        ),
      );
      const work = service.handleFetchMessage(ambiguous);
      await vi.advanceTimersByTimeAsync(reviewsDelay);
      reviewGate.resolve(json(completed));
      await vi.advanceTimersByTimeAsync(30_000 - reviewsDelay);
      expect(await work).toMatchObject(timeout);
      eventGate.resolve(json([]));
      await vi.advanceTimersByTimeAsync(0);
      expect(await work).toMatchObject(timeout);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps user cancellation during optional body reading as cancellation", async () => {
    const body = deferred<unknown>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string) => {
        if (_url.includes("/reviews")) return json(completed);
        const response = json([]);
        vi.spyOn(response, "json").mockReturnValue(body.promise);
        return response;
      }),
    );
    const work = service.handleFetchMessage(ambiguous);
    await vi.advanceTimersByTimeAsync(1);
    service.cancelRequest(ambiguous.requestId);
    expect(await work).toMatchObject({
      ok: false,
      error: { failures: [{ kind: "cancellation" }] },
    });
    body.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
