import type { ReviewerClock } from "./reviewer-deadline";

/**
 * OAuth device flow, token refresh, `/user` and installation discovery.
 * Each request (fetch and body read) gets its own bound; reviewer deadlines
 * have their own owner and are not extended by this one.
 */
export const CREDENTIAL_REQUEST_TIMEOUT_MS = 15_000;

/** The same injectable timer shape as reviewer deadlines, without a clock. */
export type CredentialTimer = Pick<
  ReviewerClock,
  "setTimeout" | "clearTimeout"
>;

const timers: CredentialTimer = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

export class CredentialTimeoutError extends Error {
  constructor() {
    super("GitHub credential request timed out.");
    this.name = "CredentialTimeoutError";
  }
}

/**
 * Runs one credential request with a bounded lifetime. The request's signal
 * aborts at the deadline or when the caller's signal aborts, and the returned
 * promise settles then even if the transport ignores the signal.
 *
 * A response read before the deadline is kept: GitHub may already have rotated
 * a refresh token or consumed a device code for it, so a completed exchange is
 * never discarded because a timer callback ran late.
 */
export async function withCredentialTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timer?: CredentialTimer } = {},
): Promise<T> {
  const parent = options.signal;
  parent?.throwIfAborted();
  const timer = options.timer ?? timers;
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", cancel, { once: true });
  const timeout = timer.setTimeout(
    () => controller.abort(new CredentialTimeoutError()),
    CREDENTIAL_REQUEST_TIMEOUT_MS,
  );
  const { signal } = controller;
  try {
    return await new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      // Observe a late settlement too, so an abandoned request never rejects
      // unhandled.
      run(signal)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  } finally {
    timer.clearTimeout(timeout);
    parent?.removeEventListener("abort", cancel);
  }
}
