import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import { fetchPullReviewerSummary, extractGitHubApiStatus } from "../github/api";
import { getAccountById, markAccountInvalidated } from "../storage/accounts";
import {
  serializeReviewerFetchError,
  type FetchPullReviewerSummaryMessage,
  type FetchPullReviewerSummaryResponse,
} from "../runtime/reviewer-fetch";

export type ReviewerFetchService = {
  cancelRequest(requestId: string): void;
  handleFetchMessage(
    message: FetchPullReviewerSummaryMessage,
  ): Promise<FetchPullReviewerSummaryResponse>;
};

export function createReviewerFetchService(input: {
  refreshCoordinator: RefreshCoordinator;
}): ReviewerFetchService {
  const { refreshCoordinator } = input;
  const inFlightControllers = new Map<string, AbortController>();
  const canceledRequestIds = new Map<string, number>();

  function pruneCanceledRequestIds(now: number): void {
    const maxAgeMs = 60_000;
    for (const [requestId, createdAt] of canceledRequestIds) {
      if (now - createdAt > maxAgeMs) {
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
  };
}
