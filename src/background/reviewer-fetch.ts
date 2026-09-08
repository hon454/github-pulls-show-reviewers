import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import type { RepositoryAccountService } from "./repository-accounts";
import type { DiscoveryOwner } from "./repository-discovery-ledger";
import type { RepositoryDiscovery } from "../runtime/repository-discovery";
import { ReviewerFetchRuntimeError } from "../runtime/reviewer-fetch";
import {
  fetchPullReviewerMetadataBatch,
  fetchPullReviewerSummary,
  extractGitHubApiStatus,
} from "../github/api";
import { accountMutations, credentialGeneration } from "../storage/accounts";
import {
  serializeReviewerFetchError,
  type FetchPullReviewerMetadataBatchMessage,
  type FetchPullReviewerMetadataBatchResponse,
  type FetchPullReviewerSummaryMessage,
  type FetchPullReviewerSummaryResponse,
  type ReviewerFetchErrorEnvelope,
} from "../runtime/reviewer-fetch";

export const CANCELED_REQUEST_TTL_MS = 60_000;
type RepositoryFetchContext = {
  service: RepositoryAccountService;
  owner: DiscoveryOwner;
  discovery: RepositoryDiscovery;
};

export type ReviewerFetchService = {
  cancelRequest(requestId: string): void;
  handleFetchMessage(
    message: FetchPullReviewerSummaryMessage,
    context?: RepositoryFetchContext,
  ): Promise<FetchPullReviewerSummaryResponse>;
  handleMetadataBatchMessage(
    message: FetchPullReviewerMetadataBatchMessage,
    context?: RepositoryFetchContext,
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
  const inFlightControllers = new Map<string, Set<AbortController>>();
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
    const controllers = inFlightControllers.get(requestId) ?? new Set();
    controllers.add(controller);
    inFlightControllers.set(requestId, controllers);

    if (canceledRequestIds.has(requestId)) {
      controller.abort();
    }

    return controller;
  }
  function releaseController(requestId: string, controller: AbortController) {
    const controllers = inFlightControllers.get(requestId);
    controllers?.delete(controller);
    if (controllers?.size === 0) inFlightControllers.delete(requestId);
  }

  async function runWithRefreshRetry<
    Result,
    SuccessResponse extends { ok: true },
  >(
    message: ReviewerFetchMessage,
    execute: (token: string | null, signal: AbortSignal) => Promise<Result>,
    toSuccessResponse: (result: Result) => SuccessResponse,
  ): Promise<SuccessResponse | ReviewerFetchFailureResponse> {
    const controller = createController(message.requestId);

    try {
      const account =
        message.accountId == null
          ? null
          : await accountMutations.getAccountById(message.accountId);

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

        const outcome = await refreshCoordinator.refreshAccountToken(
          account.id,
          credentialGeneration(account),
        );
        if (outcome.ok !== true) {
          return {
            ok: false,
            error: serializeReviewerFetchError(error),
          };
        }

        const refreshed = await accountMutations.getAccountById(account.id);
        if (
          refreshed == null ||
          refreshed.invalidated ||
          controller.signal.aborted
        ) {
          return { ok: false, error: serializeReviewerFetchError(error) };
        }
        try {
          const result = await execute(refreshed.token, controller.signal);
          return toSuccessResponse(result);
        } catch (retryError) {
          if (extractGitHubApiStatus(retryError) === 401) {
            await refreshCoordinator.invalidateAccountToken(
              account.id,
              credentialGeneration(refreshed),
            );
          }
          return {
            ok: false,
            error: serializeReviewerFetchError(retryError),
          };
        }
      }
    } finally {
      releaseController(message.requestId, controller);
    }
  }

  return {
    cancelRequest(requestId: string): void {
      const now = Date.now();
      pruneCanceledRequestIds(now);
      canceledRequestIds.set(requestId, now);
      for (const controller of inFlightControllers.get(requestId) ?? [])
        controller.abort();
    },
    async handleFetchMessage(
      message: FetchPullReviewerSummaryMessage,
      context?: RepositoryFetchContext,
    ): Promise<FetchPullReviewerSummaryResponse> {
      if (context) {
        const controller = createController(message.requestId);
        try {
          const result = await context.service.summary(
            context.owner,
            context.discovery,
            {
              pullNumber: message.pullNumber,
              signal: controller.signal,
              ...(message.pullMetadata
                ? { pullMetadata: message.pullMetadata }
                : {}),
              metadataAccount:
                message.accountId !== null && message.accountRevision
                  ? { id: message.accountId, revision: message.accountRevision }
                  : null,
            },
          );
          return { ok: true, ...result };
        } catch (error) {
          return {
            ok: false,
            error: serializeReviewerFetchError(error),
            ...(error instanceof ReviewerFetchRuntimeError
              ? { account: error.account }
              : {}),
          };
        } finally {
          releaseController(message.requestId, controller);
        }
      }
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
      context?: RepositoryFetchContext,
    ): Promise<FetchPullReviewerMetadataBatchResponse> {
      if (context) {
        const controller = createController(message.requestId);
        try {
          const result = await context.service.metadata(
            context.owner,
            context.discovery,
            controller.signal,
            message.targetPullNumbers,
            message.refresh,
          );
          return {
            ok: true,
            metadata: result.metadata ?? [],
            account: result.account,
          };
        } catch (error) {
          return {
            ok: false,
            error: serializeReviewerFetchError(error),
            ...(error instanceof ReviewerFetchRuntimeError
              ? { account: error.account }
              : {}),
          };
        } finally {
          releaseController(message.requestId, controller);
        }
      }
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
