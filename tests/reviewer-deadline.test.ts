import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReviewerDeadline,
  REVIEWER_DEADLINES,
  ReviewerTimeoutError,
  withReviewerDeadline,
} from "../src/shared/reviewer-deadline";
import { deferred } from "./helpers/auth-harness";

afterEach(() => vi.useRealTimers());

describe("reviewer deadline ownership", () => {
  it("keeps production defaults independent of injected test clocks", async () => {
    expect(REVIEWER_DEADLINES).toEqual({
      metadata: 30_000,
      summary: 30_000,
      events: 10_000,
      rpc: 35_000,
    });
    let now = 0;
    const clear = vi.fn();
    const expire = vi.fn();
    const deadline = createReviewerDeadline(20, undefined, {
      now: () => now,
      setTimeout: expire,
      clearTimeout: clear,
    });
    const pending = deferred<string>();
    const result = deadline
      .wait(pending.promise)
      .catch((error: unknown) => error);
    // A late success loses even when the event loop has not run its timer.
    now = 21;
    pending.resolve("late");
    expect(await result).toBeInstanceOf(ReviewerTimeoutError);
    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
    deadline.dispose();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledWith(expect.any(Function), 20);
    expect(REVIEWER_DEADLINES.summary).toBe(30_000);
  });

  it.each(["success", "failure", "cancel", "timeout"])(
    "cleans timers and listeners once on %s despite late settlements",
    async (outcome) => {
      vi.useFakeTimers();
      const parent = new AbortController();
      const remove = vi.spyOn(parent.signal, "removeEventListener");
      const pending = deferred<string>();
      const deadline = createReviewerDeadline(100, parent.signal);
      const removeOwn = vi.spyOn(deadline.signal, "removeEventListener");
      const work = deadline
        .wait(pending.promise)
        .catch((error: unknown) => error);
      if (outcome === "success") pending.resolve("ok");
      else if (outcome === "failure") pending.reject(new TypeError("offline"));
      else if (outcome === "cancel") parent.abort();
      else await vi.advanceTimersByTimeAsync(100);
      const result = await work;
      if (outcome === "success") expect(result).toBe("ok");
      if (outcome === "cancel")
        expect(result).toMatchObject({ name: "AbortError" });
      if (outcome === "timeout")
        expect(result).toBeInstanceOf(ReviewerTimeoutError);
      if (outcome === "failure") expect(result).toBeInstanceOf(TypeError);
      deadline.dispose();
      pending.resolve("late");
      parent.abort();
      await vi.advanceTimersByTimeAsync(200);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(removeOwn).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds an optional child by the remaining parent time", async () => {
    vi.useFakeTimers();
    const parent = createReviewerDeadline(30_000);
    await vi.advanceTimersByTimeAsync(25_000);
    let child!: AbortSignal;
    const work = withReviewerDeadline(10_000, parent.signal, (signal) => {
      child = signal;
      return new Promise(() => {});
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await work).toBe(parent.signal.reason);
    expect(child.reason).toBe(parent.signal.reason);
    parent.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not enter already-canceled work", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    parent.abort();
    const run = vi.fn();
    await expect(
      withReviewerDeadline(100, parent.signal, run),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
