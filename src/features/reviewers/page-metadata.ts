import type { PullReviewerMetadata } from "../../github/api";
import type { PullListRoute } from "../../github/routes";
import type { Account } from "../../storage/accounts";

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
};

export type PageMetadataCoordinator = {
  get(input: {
    route: PullListRoute;
    account: Account | null;
    targetPullNumbers: string[];
    signal: AbortSignal;
  }): Promise<PageMetadataResult>;
  markStale(): void;
  abortAndClear(): void;
};

type PageMetadataRequest = {
  owner: string;
  repo: string;
  accountId: string | null;
  targetPullNumbersKey: string;
  sequence: number;
  promise: Promise<PageMetadataResult>;
  controller: AbortController;
};

type PageMetadataCache = {
  owner: string;
  repo: string;
  accountId: string | null;
  targetPullNumbers: string[];
  targetPullNumbersKey: string;
  metadata: Map<string, PullReviewerMetadata>;
  fetchedAt: number;
  sequence: number;
  stale: boolean;
  failure: PageMetadataFailure | null;
};

export function createPageMetadataCoordinator(input: {
  fallbackAccounts: FallbackAccountIntegration;
  fetchMetadata?: typeof fetchReviewerMetadataBatch;
  now?: () => number;
}): PageMetadataCoordinator {
  const fetchMetadata = input.fetchMetadata ?? fetchReviewerMetadataBatch;
  const now = input.now ?? Date.now;
  let request: PageMetadataRequest | null = null;
  let cache: PageMetadataCache | null = null;
  let sequence = 0;

  function cacheIsFresh(candidate: PageMetadataCache): boolean {
    return (
      !candidate.stale && now() - candidate.fetchedAt <= PAGE_METADATA_FRESH_MS
    );
  }

  function readExactCache(args: {
    route: PullListRoute;
    accountId: string | null;
    targetPullNumbersKey: string;
  }): PageMetadataCache | null {
    if (
      cache == null ||
      cache.owner !== args.route.owner ||
      cache.repo !== args.route.repo ||
      cache.accountId !== args.accountId ||
      cache.targetPullNumbersKey !== args.targetPullNumbersKey ||
      !cacheIsFresh(cache)
    ) {
      return null;
    }
    return cache;
  }

  function readCoveringCache(args: {
    route: PullListRoute;
    accountId: string | null;
    targetPullNumbers: string[];
  }): PageMetadataCache | null {
    if (
      cache == null ||
      cache.owner !== args.route.owner ||
      cache.repo !== args.route.repo ||
      cache.accountId !== args.accountId ||
      cache.failure != null ||
      !cacheIsFresh(cache)
    ) {
      return null;
    }

    return args.targetPullNumbers.every((pullNumber) =>
      cache?.metadata.has(pullNumber),
    )
      ? cache
      : null;
  }

  function resultFromCache(candidate: PageMetadataCache): PageMetadataResult {
    return {
      metadata: candidate.metadata,
      failure: candidate.failure,
    };
  }

  function writeCache(nextCache: PageMetadataCache): PageMetadataCache {
    if (cache != null && cache.sequence > nextCache.sequence) {
      return cache;
    }
    cache = nextCache;
    return cache;
  }

  async function get(args: {
    route: PullListRoute;
    account: Account | null;
    targetPullNumbers: string[];
    signal: AbortSignal;
  }): Promise<PageMetadataResult> {
    const cachedFallbackAccount =
      args.account == null
        ? input.fallbackAccounts.read(args.route.owner)
        : undefined;
    const requestAccount = cachedFallbackAccount ?? args.account;
    const accountId = requestAccount?.id ?? null;
    const targetPullNumbersKey = args.targetPullNumbers.join(",");
    const cached = readExactCache({
      route: args.route,
      accountId,
      targetPullNumbersKey,
    });
    if (cached != null) {
      return resultFromCache(cached);
    }

    if (
      request != null &&
      request.owner === args.route.owner &&
      request.repo === args.route.repo &&
      request.accountId === accountId &&
      request.targetPullNumbersKey === targetPullNumbersKey
    ) {
      return request.promise;
    }

    const controller = new AbortController();
    args.signal.addEventListener(
      "abort",
      () => {
        controller.abort();
      },
      { once: true },
    );

    const requestSequence = sequence + 1;
    sequence = requestSequence;
    const nextRequest: PageMetadataRequest = {
      owner: args.route.owner,
      repo: args.route.repo,
      accountId,
      targetPullNumbersKey,
      sequence: requestSequence,
      controller,
      promise: fetchMetadata({
        account: requestAccount,
        owner: args.route.owner,
        repo: args.route.repo,
        targetPullNumbers: args.targetPullNumbers,
        signal: controller.signal,
      })
        .then((metadata) => {
          const metadataByNumber = new Map(
            metadata.map((pullMetadata) => [pullMetadata.number, pullMetadata]),
          );
          const nextCache = writeCache({
            owner: args.route.owner,
            repo: args.route.repo,
            accountId,
            targetPullNumbers: args.targetPullNumbers,
            targetPullNumbersKey,
            metadata: metadataByNumber,
            fetchedAt: now(),
            sequence: nextRequest.sequence,
            stale: false,
            failure: null,
          });
          return resultFromCache(nextCache);
        })
        .catch(async (error) => {
          if (!isAbortError(error) && !controller.signal.aborted) {
            let failureAccount = requestAccount;
            let failureError = error;
            if (args.account == null && shouldRetryWithFallbackAccount(error)) {
              const fallbackAccount = await input.fallbackAccounts.get(
                args.route.owner,
              );
              if (fallbackAccount != null && !controller.signal.aborted) {
                if (request === nextRequest) {
                  nextRequest.accountId = fallbackAccount.id;
                }
                try {
                  const metadata = await fetchMetadata({
                    account: fallbackAccount,
                    owner: args.route.owner,
                    repo: args.route.repo,
                    signal: controller.signal,
                    targetPullNumbers: args.targetPullNumbers,
                  });
                  const metadataByNumber = new Map(
                    metadata.map((pullMetadata) => [
                      pullMetadata.number,
                      pullMetadata,
                    ]),
                  );
                  const nextCache = writeCache({
                    owner: args.route.owner,
                    repo: args.route.repo,
                    accountId: fallbackAccount.id,
                    targetPullNumbers: args.targetPullNumbers,
                    targetPullNumbersKey,
                    metadata: metadataByNumber,
                    fetchedAt: now(),
                    sequence: nextRequest.sequence,
                    stale: false,
                    failure: null,
                  });
                  return resultFromCache(nextCache);
                } catch (fallbackError) {
                  if (controller.signal.aborted) {
                    return emptyResult();
                  }
                  failureAccount = fallbackAccount;
                  failureError = fallbackError;
                }
              }
            }
            const coveringCache = readCoveringCache({
              route: args.route,
              accountId: failureAccount?.id ?? accountId,
              targetPullNumbers: args.targetPullNumbers,
            });
            if (
              coveringCache != null &&
              coveringCache.sequence > nextRequest.sequence
            ) {
              return resultFromCache(coveringCache);
            }
            const failure = shouldRetryWithFallbackAccount(failureError)
              ? {
                  account: failureAccount,
                  error: failureError,
                  reported: false,
                  suppressRowFallback: true,
                }
              : null;
            const nextCache = writeCache({
              owner: args.route.owner,
              repo: args.route.repo,
              accountId: failureAccount?.id ?? accountId,
              targetPullNumbers: args.targetPullNumbers,
              targetPullNumbersKey,
              metadata: new Map(),
              fetchedAt: now(),
              sequence: nextRequest.sequence,
              stale: false,
              failure,
            });
            return {
              metadata: nextCache.metadata,
              failure: nextCache.failure,
            };
          }
          return emptyResult();
        })
        .finally(() => {
          if (request === nextRequest) {
            request = null;
          }
        }),
    };
    request = nextRequest;
    return nextRequest.promise;
  }

  return {
    get,
    markStale(): void {
      cache = cache == null ? null : { ...cache, stale: true };
    },
    abortAndClear(): void {
      request?.controller.abort();
      request = null;
      cache = null;
    },
  };
}

function emptyResult(): PageMetadataResult {
  return {
    metadata: new Map<string, PullReviewerMetadata>(),
    failure: null,
  };
}
