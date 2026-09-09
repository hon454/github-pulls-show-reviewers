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

// Keep the original operation clock with its signal, without adding timers or
// exposing deadline configuration through runtime messages. Continuations must
// observe elapsed time even before a busy event loop dispatches the timer.
const deadlineChecks = new WeakMap<AbortSignal, () => void>();

function checkReviewerDeadline(signal?: AbortSignal): void {
  if (signal && !signal.aborted) deadlineChecks.get(signal)?.();
}

export function reviewerAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof ReviewerTimeoutError
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

export function throwIfReviewerAborted(signal?: AbortSignal): void {
  checkReviewerDeadline(signal);
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
    checkReviewerDeadline(signal);
    if (signal.aborted) abort();
    // Always observe the late promise, including when already canceled.
    work.then(
      (value) => {
        if (settled) return;
        checkReviewerDeadline(signal);
        finish(() => resolve(value));
      },
      (error: unknown) => {
        if (settled) return;
        checkReviewerDeadline(signal);
        finish(() => reject(error));
      },
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
  deadlineChecks.set(controller.signal, () => {
    // Mandatory parent expiry wins over optional child fallback.
    checkReviewerDeadline(parent);
    if (timer.now() >= expiresAt && !controller.signal.aborted) expire();
  });
  const timeout = timer.setTimeout(
    expire,
    Math.max(0, expiresAt - timer.now()),
  );
  let disposed = false;
  return {
    controller,
    signal: controller.signal,
    async wait<T>(work: Promise<T>): Promise<T> {
      try {
        return await waitForReviewerSignal(work, controller.signal);
      } finally {
        // A delayed timer cannot let either a late success or failure win.
        throwIfReviewerAborted(controller.signal);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      timer.clearTimeout(timeout);
      parent?.removeEventListener("abort", cancel);
      deadlineChecks.delete(controller.signal);
    },
  };
}

export async function withReviewerDeadline<T>(
  duration: number,
  parent: AbortSignal | undefined,
  run: (signal: AbortSignal, controller: AbortController) => Promise<T>,
  timer?: ReviewerClock,
): Promise<T> {
  const deadline = createReviewerDeadline(duration, parent, timer);
  try {
    throwIfReviewerAborted(deadline.signal);
    return await deadline.wait(run(deadline.signal, deadline.controller));
  } finally {
    deadline.dispose();
  }
}
