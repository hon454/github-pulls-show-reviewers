import type { CacheKey } from "../../cache/reviewer-cache";

export type ReviewerRequest = {
  /** Identity of this attempt for outcomes and delayed-render rejection. */
  readonly owner: object;
  readonly controller: AbortController;
  /** Mounts waiting on this request, each with its row's liveness check. */
  readonly consumers: Map<HTMLElement, () => boolean>;
  /** Settles when the request pipeline has finished; assigned by the starter. */
  promise: Promise<void>;
  /** A meaningful row change arrived while the request was in flight. */
  invalidated: boolean;
  succeeded: boolean;
};

export type ReviewerRequestRegistry = ReturnType<
  typeof createReviewerRequestRegistry
>;

/** Owns per-pull request identity. It never fetches, renders or schedules. */
export function createReviewerRequestRegistry() {
  const inflight = new Map<CacheKey, ReviewerRequest>();
  // Keep the last request identity after settlement to reject delayed renders.
  const owners = new Map<CacheKey, object>();

  return {
    get(key: CacheKey): ReviewerRequest | undefined {
      return inflight.get(key);
    },
    ownerOf(key: CacheKey): object | undefined {
      return owners.get(key);
    },
    start(
      key: CacheKey,
      mount: HTMLElement,
      isRowCurrent: () => boolean,
    ): ReviewerRequest {
      const request: ReviewerRequest = {
        owner: {},
        controller: new AbortController(),
        consumers: new Map([[mount, isRowCurrent]]),
        promise: Promise.resolve(),
        invalidated: false,
        succeeded: false,
      };
      inflight.set(key, request);
      owners.set(key, request.owner);
      return request;
    },
    join(
      request: ReviewerRequest,
      mount: HTMLElement,
      isRowCurrent: () => boolean,
    ): void {
      request.consumers.set(mount, isRowCurrent);
    },
    // Data belongs to live rows, even if their presentation mounts were removed.
    // A replacement row may still need the shared request after its owner left.
    isCurrent(key: CacheKey, request: ReviewerRequest): boolean {
      return (
        !request.controller.signal.aborted &&
        inflight.get(key) === request &&
        [...request.consumers.values()].some((isCurrent) => isCurrent())
      );
    },
    liveConsumers(request: ReviewerRequest): HTMLElement[] {
      return [...request.consumers]
        .filter(([, isCurrent]) => isCurrent())
        .map(([mount]) => mount);
    },
    invalidate(key: CacheKey): void {
      const request = inflight.get(key);
      if (request) request.invalidated = true;
    },
    /** Returns false when another request already replaced this one. */
    release(key: CacheKey, request: ReviewerRequest): boolean {
      if (inflight.get(key) !== request) return false;
      inflight.delete(key);
      return true;
    },
    abortAll(): void {
      for (const request of inflight.values()) request.controller.abort();
      inflight.clear();
      owners.clear();
    },
  };
}
