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

  it.each(["fetch", "body", "error-body", "second-page"])(
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
          const response = json([], stage === "error-body" ? 403 : 200);
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
          requestedUsers: [{ login: "alice", avatarUrl: null }],
          reviewRequestEvidence: [{ login: "alice", status: "unverified" }],
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

  it.each(["fetch", "body", "error-body"])(
    "keeps confirmed partial evidence and unverified users when the second-page %s expires",
    async (stage) => {
      const first = deferred<Response>();
      const lateHeaders = deferred<Response>();
      const lateBody = deferred<unknown>();
      const signals: AbortSignal[] = [];
      let eventCalls = 0;
      const users = ["alice", "bob", "carol"].map((login) => ({
        login,
        avatarUrl: null,
      }));
      const reviewRows = users.map(({ login }) => ({
        ...completed[0],
        user: { login },
      }));
      const fetch = vi.fn((_url: string, init: RequestInit) => {
        if (_url.includes("/reviews")) return Promise.resolve(json(reviewRows));
        signals.push(init.signal!);
        eventCalls++;
        if (eventCalls === 1) return first.promise;
        if (stage === "fetch") return lateHeaders.promise;
        const response = json([], stage === "error-body" ? 403 : 200);
        vi.spyOn(response, "json").mockReturnValue(lateBody.promise);
        return Promise.resolve(response);
      });
      vi.stubGlobal("fetch", fetch);
      const work = service.handleFetchMessage({
        ...ambiguous,
        pullMetadata: { ...metadata, requestedUsers: users },
      });
      await vi.advanceTimersByTimeAsync(7_000);
      const response = json([
        {
          event: "review_requested",
          created_at: "2026-09-02T00:00:00Z",
          requested_reviewer: { login: "alice" },
        },
        {
          event: "review_requested",
          created_at: "2026-08-31T00:00:00Z",
          requested_reviewer: { login: "bob" },
        },
      ]);
      response.headers.set(
        "Link",
        '<https://api.github.com/repos/acme/widgets/issues/42/events?page=2>; rel="next"',
      );
      first.resolve(response);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(eventCalls).toBe(2);
      expect(signals[0]).toBe(signals[1]);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await work;
      expect(result).toMatchObject({
        ok: true,
        summary: {
          requestedUsers: users,
          completedReviews: users.map(({ login }) => ({
            login,
            state: "APPROVED",
          })),
          reviewRequestEvidence: [
            { login: "alice", status: "confirmed" },
            { login: "bob", status: "unverified" },
            { login: "carol", status: "unverified" },
          ],
        },
      });
      expect(signals[0].aborted).toBe(true);
      const lateEvents = [
        {
          event: "review_requested",
          created_at: "2026-09-03T00:00:00Z",
          requested_reviewer: { login: "bob" },
        },
      ];
      lateHeaders.resolve(json(lateEvents));
      lateBody.resolve(lateEvents);
      await vi.advanceTimersByTimeAsync(0);
      expect(await work).toEqual(result);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    { eventsStart: 0, outcome: "resolve" },
    { eventsStart: 0, outcome: "reject" },
    { eventsStart: 25_000, outcome: "resolve" },
    { eventsStart: 25_000, outcome: "reject" },
  ])(
    "checks absolute parent/child time for late $outcome with events starting at $eventsStart",
    async ({ eventsStart, outcome }) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const reviewsStarted = deferred<void>();
      const reviewGate = deferred<Response>();
      const secondPageStarted = deferred<void>();
      const pageGate = deferred<Response>();
      let eventCalls = 0;
      let eventSignal!: AbortSignal;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init: RequestInit) => {
          if (_url.includes("/reviews")) {
            reviewsStarted.resolve();
            return reviewGate.promise;
          }
          eventSignal = init.signal!;
          if (++eventCalls === 2) {
            secondPageStarted.resolve();
            return pageGate.promise;
          }
          const response = json([
            {
              event: "review_requested",
              created_at: "2026-09-02T00:00:00Z",
              requested_reviewer: { login: "alice" },
            },
          ]);
          response.headers.set(
            "Link",
            '<https://api.github.com/repos/acme/widgets/issues/42/events?page=2>; rel="next"',
          );
          return Promise.resolve(response);
        }),
      );
      const work = service.handleFetchMessage(ambiguous);
      await reviewsStarted.promise;
      now = eventsStart;
      reviewGate.resolve(json(completed));
      await secondPageStarted.promise;
      now = eventsStart === 0 ? 10_001 : 30_001;
      if (outcome === "resolve") pageGate.resolve(json([]));
      else pageGate.reject(new TypeError("late network failure"));
      if (eventsStart === 0) {
        expect(await work).toMatchObject({
          ok: true,
          summary: {
            reviewRequestEvidence: [{ login: "alice", status: "confirmed" }],
          },
        });
      } else {
        expect(await work).toMatchObject(timeout);
      }
      expect(eventSignal.aborted).toBe(true);
      expect(eventCalls).toBe(2);
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

it.each(["headers", "body"])(
  "does not fetch the next page after a late %s completion while the timer is delayed",
  async (boundary) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const headerGate = deferred<Response>();
    const bodyGate = deferred<unknown>();
    const entered = deferred<void>();
    const response = json([]);
    response.headers.set(
      "Link",
      '<https://api.github.com/repos/acme/widgets/pulls/42/reviews?page=2>; rel="next"',
    );
    if (boundary === "body")
      vi.spyOn(response, "json").mockImplementation(() => {
        entered.resolve();
        return bodyGate.promise;
      });
    const fetch = vi.fn(() => {
      if (boundary === "headers") {
        entered.resolve();
        return headerGate.promise;
      }
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetch);
    const work = service.handleFetchMessage(summaryMessage);
    await entered.promise;
    now = 30_001;
    headerGate.resolve(response);
    bodyGate.resolve([]);
    expect(await work).toMatchObject(timeout);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);
