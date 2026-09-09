import type { PullReviewerMetadata } from "../../github/api";
import type { PullListRoute } from "../../github/routes";
import type { AccountSummary as Account } from "../../runtime/ui-contract";
import {
  ReviewerFetchRuntimeError,
  extractReviewerFetchFailures,
} from "../../runtime/reviewer-fetch";
import type { FallbackAccountIntegration } from "./fallback-account";
import {
  fetchReviewerMetadataBatch,
  isAbortError,
  shouldRetryWithFallbackAccount,
} from "./runtime-requests";

const PAGE_METADATA_FRESH_MS = 10_000;
export type PageMetadataFailure = {
  account: Account | null;
  error: unknown;
  reported: boolean;
  suppressRowFallback: boolean;
};
export type PageMetadataResult = {
  metadata: Map<string, PullReviewerMetadata>;
  failure: PageMetadataFailure | null;
  account?: Account | null;
};
type Input = {
  route: PullListRoute;
  account: Account | null;
  targetPullNumbers: string[];
  signal: AbortSignal;
  discoveryId?: string;
};
export type PageMetadataCoordinator = {
  get(input: Input): Promise<PageMetadataResult>;
  markStale(): void;
  abortAndClear(): void;
};
type Request = {
  controller: AbortController;
  consumers: Set<object>;
  promise: Promise<PageMetadataResult>;
};
type Cache = {
  identity: string;
  account: Account | null;
  targets: string;
  result: PageMetadataResult;
  sequence: number;
  fetchedAt: number;
  stale: boolean;
};
const emptyResult = (): PageMetadataResult => ({
  metadata: new Map(),
  failure: null,
});

/** Caller signals own subscriptions. Only the last detach aborts the shared HTTP. */
export function createPageMetadataCoordinator(input: {
  fallbackAccounts: FallbackAccountIntegration;
  fetchMetadata?: typeof fetchReviewerMetadataBatch;
  now?: () => number;
}): PageMetadataCoordinator {
  const fetchMetadata = input.fetchMetadata ?? fetchReviewerMetadataBatch;
  const now = input.now ?? Date.now;
  const requests = new Map<string, Request>();
  let cache: Cache | undefined;
  let sequence = 0;
  let epoch = 0;
  const identity = (args: Input) =>
    JSON.stringify([
      args.route.owner.toLowerCase(),
      args.route.repo.toLowerCase(),
      args.discoveryId ?? null,
    ]);
  const accountKey = (account: Account | null) =>
    JSON.stringify([account?.id ?? null, account?.revision ?? null]);
  const fresh = (entry: Cache) =>
    !entry.stale && now() - entry.fetchedAt <= PAGE_METADATA_FRESH_MS;

  async function fetch(
    args: Input,
    account: Account | null,
    controller: AbortController,
    requestSequence: number,
    requestEpoch: number,
  ): Promise<PageMetadataResult> {
    let used = account;
    let error: unknown;
    let metadata: PullReviewerMetadata[] | undefined;
    const invoke = () =>
      fetchMetadata({
        account: used,
        owner: args.route.owner,
        repo: args.route.repo,
        targetPullNumbers: args.targetPullNumbers,
        signal: controller.signal,
        ...(cache?.stale ? { refresh: true } : {}),
        ...(args.discoveryId ? { discoveryId: args.discoveryId } : {}),
        onAccount: (actual) => {
          used = actual;
        },
      });
    try {
      metadata = await invoke();
    } catch (firstError) {
      error = firstError;
      // Compatibility for direct anonymous callers. Production discovery owns
      // its complete fallback sequence in background and never retries here.
      if (
        !args.discoveryId &&
        args.account === null &&
        shouldRetryWithFallbackAccount(error) &&
        !controller.signal.aborted
      ) {
        const fallback = await input.fallbackAccounts.get(args.route.owner);
        if (controller.signal.aborted) return emptyResult();
        if (fallback) {
          used = fallback;
          try {
            metadata = await invoke();
            error = undefined;
          } catch (fallbackError) {
            error = fallbackError;
          }
        }
      }
    }
    if (
      controller.signal.aborted ||
      requestEpoch !== epoch ||
      isAbortError(error)
    )
      return emptyResult();
    if (
      error instanceof ReviewerFetchRuntimeError &&
      error.account !== undefined
    )
      used = error.account;
    if (
      error &&
      cache &&
      cache.sequence > requestSequence &&
      cache.identity === identity(args) &&
      accountKey(cache.account) === accountKey(used) &&
      fresh(cache) &&
      cache.result.failure === null &&
      args.targetPullNumbers.every((number) =>
        cache!.result.metadata.has(number),
      )
    )
      return cache.result;
    const result: PageMetadataResult = {
      metadata: new Map((metadata ?? []).map((pull) => [pull.number, pull])),
      failure:
        error &&
        (args.discoveryId ||
          shouldRetryWithFallbackAccount(error) ||
          extractReviewerFetchFailures(error).some(
            (failure) => failure.kind === "timeout",
          ))
          ? { account: used, error, reported: false, suppressRowFallback: true }
          : null,
      account: used,
    };
    if (!cache || cache.sequence <= requestSequence)
      cache = {
        identity: identity(args),
        account: used,
        targets: args.targetPullNumbers.join(","),
        result,
        sequence: requestSequence,
        fetchedAt: now(),
        stale: false,
      };
    return result;
  }
  function join(
    request: Request,
    signal: AbortSignal,
  ): Promise<PageMetadataResult> {
    const consumer = {};
    request.consumers.add(consumer);
    return new Promise((resolve) => {
      let detached = false;
      const detach = () => {
        if (detached) return;
        detached = true;
        signal.removeEventListener("abort", cancel);
        request.consumers.delete(consumer);
      };
      const cancel = () => {
        detach();
        resolve(emptyResult());
        if (request.consumers.size === 0) request.controller.abort();
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      request.promise.then(
        (result) => {
          detach();
          if (!signal.aborted) resolve(result);
        },
        () => {
          detach();
          resolve(emptyResult());
        },
      );
    });
  }
  return {
    async get(args) {
      if (args.signal.aborted) return emptyResult();
      const account = args.discoveryId
        ? args.account
        : ((args.account === null
            ? input.fallbackAccounts.read(args.route.owner)
            : undefined) ?? args.account);
      const targets = args.targetPullNumbers.join(",");
      // A discovery key resolves its actual account in background; it never
      // stores B's payload under the caller's initial A credential identity.
      if (
        cache &&
        cache.identity === identity(args) &&
        (args.discoveryId ||
          accountKey(cache.account) === accountKey(account)) &&
        cache.targets === targets &&
        fresh(cache)
      )
        return cache.result;
      const key = JSON.stringify([
        identity(args),
        args.discoveryId ? null : accountKey(account),
        targets,
      ]);
      let request = requests.get(key);
      if (!request || request.controller.signal.aborted) {
        const controller = new AbortController();
        const requestSequence = ++sequence;
        const requestEpoch = epoch;
        const created: Request = {
          controller,
          consumers: new Set(),
          promise: Promise.resolve(emptyResult()),
        };
        requests.set(key, created);
        created.promise = fetch(
          args,
          account,
          controller,
          requestSequence,
          requestEpoch,
        ).finally(() => {
          if (requests.get(key) === created) requests.delete(key);
        });
        request = created;
      }
      return join(request, args.signal);
    },
    markStale() {
      if (cache) cache.stale = true;
    },
    abortAndClear() {
      epoch += 1;
      for (const request of requests.values()) request.controller.abort();
      requests.clear();
      cache = undefined;
    },
  };
}
