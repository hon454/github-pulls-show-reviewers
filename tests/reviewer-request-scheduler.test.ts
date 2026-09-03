import { afterEach, describe, expect, it, vi } from "vitest";

import { createAbortAwareRequestScheduler } from "../src/features/reviewers/request-scheduler";
import {
  FILTERED_PULL_LIST_PULL_NUMBERS,
  REPRESENTATIVE_PULL_LIST_PULL_NUMBERS,
} from "./helpers/pull-list-fixtures";

afterEach(() => {
  vi.useRealTimers();
});

describe("abort-aware reviewer request scheduler", () => {
  it.each([
    {
      name: "representative 25-row list",
      pullNumbers: REPRESENTATIVE_PULL_LIST_PULL_NUMBERS,
      boundedLatencyMs: 700,
    },
    {
      name: "filtered 8-row list",
      pullNumbers: FILTERED_PULL_LIST_PULL_NUMBERS,
      boundedLatencyMs: 200,
    },
  ])(
    "measures unbounded and four-wide request shape for a $name",
    async ({ pullNumbers, boundedLatencyMs }) => {
      vi.useFakeTimers({ now: 0 });

      const before = await measureScenario(pullNumbers, pullNumbers.length);
      const after = await measureScenario(pullNumbers, 4);

      expect(before).toEqual({
        requestCount: pullNumbers.length,
        peakConcurrency: pullNumbers.length,
        firstResultLatencyMs: 100,
        allResultsLatencyMs: 100,
      });
      expect(after).toEqual({
        requestCount: pullNumbers.length,
        peakConcurrency: 4,
        firstResultLatencyMs: 100,
        allResultsLatencyMs: boundedLatencyMs,
      });
    },
  );

  it("rejects queued work on abort without consuming a request slot", async () => {
    const scheduler = createAbortAwareRequestScheduler(1);
    const first = createDeferred<void>();
    const firstRequest = scheduler.run(
      () => first.promise,
      new AbortController().signal,
    );
    const queuedController = new AbortController();
    const queuedTask = vi.fn(async () => "queued");
    const queuedRequest = scheduler.run(queuedTask, queuedController.signal);
    const nextTask = vi.fn(async () => "next");
    const nextRequest = scheduler.run(nextTask, new AbortController().signal);

    queuedController.abort();
    await expect(queuedRequest).rejects.toMatchObject({ name: "AbortError" });
    expect(queuedTask).not.toHaveBeenCalled();

    first.resolve();
    await expect(firstRequest).resolves.toBeUndefined();
    await expect(nextRequest).resolves.toBe("next");
    expect(nextTask).toHaveBeenCalledTimes(1);
  });

  it("rejects work whose signal was already aborted", async () => {
    const scheduler = createAbortAwareRequestScheduler(1);
    const controller = new AbortController();
    controller.abort();

    await expect(
      scheduler.run(async () => "never", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("requires a positive integer concurrency", () => {
    expect(() => createAbortAwareRequestScheduler(0)).toThrow(RangeError);
    expect(() => createAbortAwareRequestScheduler(1.5)).toThrow(RangeError);
  });
});

async function measureScenario(
  pullNumbers: readonly string[],
  concurrency: number,
): Promise<{
  requestCount: number;
  peakConcurrency: number;
  firstResultLatencyMs: number;
  allResultsLatencyMs: number;
}> {
  const scheduler = createAbortAwareRequestScheduler(concurrency);
  const controller = new AbortController();
  let activeCount = 0;
  let peakConcurrency = 0;
  let requestCount = 0;
  let firstResultLatencyMs: number | null = null;
  const startedAt = Date.now();

  const requests = pullNumbers.map((pullNumber) =>
    scheduler.run(async () => {
      requestCount += 1;
      activeCount += 1;
      peakConcurrency = Math.max(peakConcurrency, activeCount);
      await new Promise((resolve) => setTimeout(resolve, 100));
      activeCount -= 1;
      firstResultLatencyMs ??= Date.now() - startedAt;
      return pullNumber;
    }, controller.signal),
  );

  await vi.runAllTimersAsync();
  await Promise.all(requests);

  return {
    requestCount,
    peakConcurrency,
    firstResultLatencyMs: firstResultLatencyMs ?? 0,
    allResultsLatencyMs: Date.now() - startedAt,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
