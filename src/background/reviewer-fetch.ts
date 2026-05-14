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
  type ReviewerFetchErrorEnvelope,
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

type ReviewerFetchMessage = {
  requestId: string;
  accountId: string | null;
};

type ReviewerFetchFailureResponse = {
  ok: false;
  error: ReviewerFetchErrorEnvelope;
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

  function createController(requestId: string): AbortController {
    // Prune on both cancel and fetch entry so the TTL applies symmetrically
    // even when a cancel's matching fetch never arrives.
    pruneCanceledRequestIds(Date.now());

    const controller = new AbortController();
    inFlightControllers.set(requestId, controller);

    if (canceledRequestIds.delete(requestId)) {
      controller.abort();
    }

    return controller;
  }

  async function runWithRefreshRetry<Result, SuccessResponse extends { ok: true }>(
    message: ReviewerFetchMessage,
    execute: (token: string | null, signal: AbortSignal) => Promise<Result>,
    toSuccessResponse: (result: Result) => SuccessResponse,
  ): Promise<SuccessResponse | ReviewerFetchFailureResponse> {
    const controller = createController(message.requestId);

    try {
      const account =
        message.accountId == null ? null : await getAccountById(message.accountId);

      try {
        const result = await execute(account?.token ?? null, controller.signal);
        return toSuccessResponse(result);
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
          const result = await execute(
            refreshed?.token ?? outcome.token,
            controller.signal,
          );
          return toSuccessResponse(result);
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
      return runWithRefreshRetry(
        message,
        (token, signal) =>
          fetchPullReviewerSummary({
            owner: message.owner,
            repo: message.repo,
            pullNumber: message.pullNumber,
            githubToken: token,
            signal,
            ...(message.pullMetadata == null
              ? {}
              : { pullMetadata: message.pullMetadata }),
          }),
        (summary) => ({ ok: true, summary }),
      );
    },
    async handleMetadataBatchMessage(
      message: FetchPullReviewerMetadataBatchMessage,
    ): Promise<FetchPullReviewerMetadataBatchResponse> {
      return runWithRefreshRetry(
        message,
        (token, signal) =>
          fetchPullReviewerMetadataBatch({
            owner: message.owner,
            repo: message.repo,
            githubToken: token,
            signal,
            ...(message.targetPullNumbers == null
              ? {}
              : { targetPullNumbers: message.targetPullNumbers }),
          }),
        (metadata) => ({ ok: true, metadata }),
      );
    },
  };
}
