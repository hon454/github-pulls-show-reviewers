/** Reviewer operations only. Queue admission and OAuth refresh have other owners. */
export const REVIEWER_DEADLINES = Object.freeze({
  metadata: 30_000,
  summary: 30_000,
  events: 10_000,
  rpc: 35_000,
});

export type ReviewerClock = {
  now(): number;
  setTimeout(
    callback: () => void,
    delay: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

const clock: ReviewerClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

export class ReviewerTimeoutError extends Error {
  constructor() {
    super("Reviewer request timed out.");
    this.name = "ReviewerTimeoutError";
  }
}

export function reviewerAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof ReviewerTimeoutError
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

export function throwIfReviewerAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw reviewerAbortReason(signal);
}

/** Detach even from transports/refresh promises that ignore AbortSignal. */
export function waitForReviewerSignal<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => reject(reviewerAbortReason(signal)));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    // Always observe the late promise, including when already canceled.
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** A fixed lifetime; children inherit expiration through the parent signal. */
export function createReviewerDeadline(
  duration: number,
  parent?: AbortSignal,
  timer: ReviewerClock = clock,
) {
  const controller = new AbortController();
  const expiresAt = timer.now() + duration;
  const expire = () => controller.abort(new ReviewerTimeoutError());
  const cancel = () => controller.abort(reviewerAbortReason(parent!));
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) cancel();
  const timeout = timer.setTimeout(
    expire,
    Math.max(0, expiresAt - timer.now()),
  );
  let disposed = false;
  return {
    controller,
    signal: controller.signal,
    async wait<T>(work: Promise<T>): Promise<T> {
      if (timer.now() >= expiresAt && !controller.signal.aborted) expire();
      const result = await waitForReviewerSignal(work, controller.signal);
      // Timers can be delayed by a busy event loop. A late success cannot win.
      if (timer.now() >= expiresAt && !controller.signal.aborted) expire();
      throwIfReviewerAborted(controller.signal);
      return result;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      timer.clearTimeout(timeout);
      parent?.removeEventListener("abort", cancel);
    },
  };
}

export async function withReviewerDeadline<T>(
  duration: number,
  parent: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  timer?: ReviewerClock,
): Promise<T> {
  const deadline = createReviewerDeadline(duration, parent, timer);
  try {
    throwIfReviewerAborted(deadline.signal);
    return await deadline.wait(run(deadline.signal));
  } finally {
    deadline.dispose();
  }
}
