import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import {
  fetchPullReviewerMetadataBatch,
  fetchPullReviewerSummary,
  extractGitHubApiStatus,
} from "../github/api";
import { getAccountById, markAccountInvalidated } from "../storage/accounts";
import {
  serializeReviewerFetchError,
  type FetchPullReviewerMetadataBatchMessage,
  type FetchPullReviewerMetadataBatchResponse,
  type FetchPullReviewerSummaryMessage,
  type FetchPullReviewerSummaryResponse,
} from "../runtime/reviewer-fetch";

export const CANCELED_REQUEST_TTL_MS = 60_000;

export type ReviewerFetchService = {
  cancelRequest(requestId: string): void;
  handleFetchMessage(
    message: FetchPullReviewerSummaryMessage,
  ): Promise<FetchPullReviewerSummaryResponse>;
  handleMetadataBatchMessage(
    message: FetchPullReviewerMetadataBatchMessage,
  ): Promise<FetchPullReviewerMetadataBatchResponse>;
};

export function createReviewerFetchService(input: {
  refreshCoordinator: RefreshCoordinator;
}): ReviewerFetchService {
  const { refreshCoordinator } = input;
  const inFlightControllers = new Map<string, AbortController>();
  const canceledRequestIds = new Map<string, number>();

  function pruneCanceledRequestIds(now: number): void {
    for (const [requestId, createdAt] of canceledRequestIds) {
      if (now - createdAt > CANCELED_REQUEST_TTL_MS) {
        canceledRequestIds.delete(requestId);
      }
    }
  }

  return {
    cancelRequest(requestId: string): void {
      const controller = inFlightControllers.get(requestId);
      if (controller != null) {
        controller.abort();
        return;
      }

      const now = Date.now();
      pruneCanceledRequestIds(now);
      canceledRequestIds.set(requestId, now);
    },
    async handleFetchMessage(
      message: FetchPullReviewerSummaryMessage,
    ): Promise<FetchPullReviewerSummaryResponse> {
      // Prune on both cancel and fetch entry so the TTL applies symmetrically
      // even when a cancel's matching fetch never arrives.
      pruneCanceledRequestIds(Date.now());

      const controller = new AbortController();
      inFlightControllers.set(message.requestId, controller);

      if (canceledRequestIds.delete(message.requestId)) {
        controller.abort();
      }

      try {
        const account =
          message.accountId == null ? null : await getAccountById(message.accountId);

        const execute = (token: string | null) =>
          fetchPullReviewerSummary({
            owner: message.owner,
            repo: message.repo,
            pullNumber: message.pullNumber,
            githubToken: token,
            signal: controller.signal,
            ...(message.pullMetadata == null
              ? {}
              : { pullMetadata: message.pullMetadata }),
          });

        try {
          const summary = await execute(account?.token ?? null);
          return { ok: true, summary };
        } catch (error) {
          if (extractGitHubApiStatus(error) !== 401 || account == null) {
            return {
              ok: false,
              error: serializeReviewerFetchError(error),
            };
          }

          if (account.refreshToken == null) {
            await markAccountInvalidated(account.id, "revoked");
            return {
              ok: false,
              error: serializeReviewerFetchError(error),
            };
          }

          const outcome = await refreshCoordinator.refreshAccountToken(account.id);
          if (outcome.ok !== true) {
            return {
              ok: false,
              error: serializeReviewerFetchError(error),
            };
          }

          const refreshed = await getAccountById(account.id);
          try {
            const summary = await execute(refreshed?.token ?? outcome.token);
            return { ok: true, summary };
          } catch (retryError) {
            if (extractGitHubApiStatus(retryError) === 401) {
              await markAccountInvalidated(account.id, "revoked");
            }
            return {
              ok: false,
              error: serializeReviewerFetchError(retryError),
            };
          }
        }
      } finally {
        inFlightControllers.delete(message.requestId);
      }
    },
    async handleMetadataBatchMessage(
      message: FetchPullReviewerMetadataBatchMessage,
    ): Promise<FetchPullReviewerMetadataBatchResponse> {
      pruneCanceledRequestIds(Date.now());

      const controller = new AbortController();
      inFlightControllers.set(message.requestId, controller);

      if (canceledRequestIds.delete(message.requestId)) {
        controller.abort();
      }

      try {
        const account =
          message.accountId == null ? null : await getAccountById(message.accountId);

        const execute = (token: string | null) =>
          fetchPullReviewerMetadataBatch({
            owner: message.owner,
            repo: message.repo,
            githubToken: token,
            signal: controller.signal,
          });

        try {
          const metadata = await execute(account?.token ?? null);
          return { ok: true, metadata };
        } catch (error) {
          if (extractGitHubApiStatus(error) !== 401 || account == null) {
            return {
              ok: false,
              error: serializeReviewerFetchError(error),
            };
          }

          if (account.refreshToken == null) {
            await markAccountInvalidated(account.id, "revoked");
            return {
              ok: false,
              error: serializeReviewerFetchError(error),
            };
          }

          const outcome = await refreshCoordinator.refreshAccountToken(account.id);
          if (outcome.ok !== true) {
            return {
              ok: false,
              error: serializeReviewerFetchError(error),
            };
          }

          const refreshed = await getAccountById(account.id);
          try {
            const metadata = await execute(refreshed?.token ?? outcome.token);
            return { ok: true, metadata };
          } catch (retryError) {
            if (extractGitHubApiStatus(retryError) === 401) {
              await markAccountInvalidated(account.id, "revoked");
            }
            return {
              ok: false,
              error: serializeReviewerFetchError(retryError),
            };
          }
        }
      } finally {
        inFlightControllers.delete(message.requestId);
      }
    },
  };
}
