import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_REQUEST_TIMEOUT_MS,
  CredentialTimeoutError,
  withCredentialTimeout,
} from "../src/shared/credential-deadline";
import { REVIEWER_DEADLINES } from "../src/shared/reviewer-deadline";
import { deferred } from "./helpers/auth-harness";

afterEach(() => vi.useRealTimers());

function manualTimer() {
  const callbacks: Array<() => void> = [];
  const timer = {
    setTimeout: vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    }),
    clearTimeout: vi.fn(),
  };
  return { timer, fire: () => callbacks.forEach((callback) => callback()) };
}

describe("credential request deadline", () => {
  it("uses its own bounded default without changing reviewer deadlines", async () => {
    expect(CREDENTIAL_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(REVIEWER_DEADLINES).toEqual({
      metadata: 30_000,
      summary: 30_000,
      events: 10_000,
      rpc: 35_000,
    });
    const { timer } = manualTimer();
    await withCredentialTimeout(async () => "ok", { timer });
    expect(timer.setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      CREDENTIAL_REQUEST_TIMEOUT_MS,
    );
    expect(timer.clearTimeout).toHaveBeenCalledTimes(1);
  });

  it("aborts hung work and settles even when the transport ignores the signal", async () => {
    const { timer, fire } = manualTimer();
    let seen!: AbortSignal;
    const work = withCredentialTimeout(
      (signal) => {
        seen = signal;
        return new Promise<never>(() => {});
      },
      { timer },
    ).catch((error: unknown) => error);
    fire();
    const error = await work;
    expect(error).toBeInstanceOf(CredentialTimeoutError);
    expect(seen.aborted).toBe(true);
    expect(seen.reason).toBe(error);
  });

  it("keeps a response that completed before the timer fired", async () => {
    const { timer, fire } = manualTimer();
    const pending = deferred<string>();
    const work = withCredentialTimeout(() => pending.promise, { timer });
    pending.resolve("rotated");
    await expect(work).resolves.toBe("rotated");
    fire();
    expect(timer.clearTimeout).toHaveBeenCalledTimes(1);
  });

  it("forwards caller cancellation without reporting a timeout", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    let seen!: AbortSignal;
    const work = withCredentialTimeout(
      (signal) => {
        seen = signal;
        return new Promise<never>(() => {});
      },
      { signal: parent.signal },
    ).catch((error: unknown) => error);
    parent.abort(reason);
    expect(await work).toBe(reason);
    expect(seen.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start work for an already cancelled caller", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    parent.abort();
    const run = vi.fn();
    await expect(
      withCredentialTimeout(run, { signal: parent.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires on the production timer after the default timeout", async () => {
    vi.useFakeTimers();
    const work = withCredentialTimeout(
      () => new Promise<never>(() => {}),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(CREDENTIAL_REQUEST_TIMEOUT_MS - 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await work).toBeInstanceOf(CredentialTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
