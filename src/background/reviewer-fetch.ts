import { projectContentAccount } from "./account-summary";
import type { RepositoryAccountService } from "./repository-accounts";
import type { DiscoveryOwner } from "./repository-discovery-ledger";
import type { RepositoryDiscovery } from "../runtime/repository-discovery";
import {
  ReviewerFetchRuntimeError,
  serializeReviewerFetchError,
  type FetchPullReviewerMetadataBatchMessage,
  type FetchPullReviewerMetadataBatchResponse,
  type FetchPullReviewerSummaryMessage,
  type FetchPullReviewerSummaryResponse,
} from "../runtime/reviewer-fetch";
import type { ContentAccount } from "../runtime/ui-contract";

export const CANCELED_REQUEST_TTL_MS = 60_000;

// Reviewer replies go only to content documents: project the account.
function contentAccount(
  account: ContentAccount | null | undefined,
): ContentAccount | null | undefined {
  return account ? projectContentAccount(account) : account;
}
function failure(error: unknown) {
  return {
    ok: false as const,
    error: serializeReviewerFetchError(error),
    ...(error instanceof ReviewerFetchRuntimeError
      ? { account: contentAccount(error.account) }
      : {}),
  };
}
/**
 * The repository binding of one reviewer request: the sender document's
 * committed discovery and the shared account service that owns its account
 * choice and token retries. There is no path that takes only an account id.
 */
export type RepositoryFetchContext = {
  service: RepositoryAccountService;
  owner: DiscoveryOwner;
  discovery: RepositoryDiscovery;
};

export type ReviewerFetchService = {
  cancelRequest(requestId: string): void;
  handleFetchMessage(
    message: FetchPullReviewerSummaryMessage,
    context: RepositoryFetchContext,
  ): Promise<FetchPullReviewerSummaryResponse>;
  handleMetadataBatchMessage(
    message: FetchPullReviewerMetadataBatchMessage,
    context: RepositoryFetchContext,
  ): Promise<FetchPullReviewerMetadataBatchResponse>;
};

export function createReviewerFetchService(): ReviewerFetchService {
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
      context: RepositoryFetchContext,
    ): Promise<FetchPullReviewerSummaryResponse> {
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
        return {
          ok: true,
          summary: result.summary,
          account: contentAccount(result.account),
        };
      } catch (error) {
        return failure(error);
      } finally {
        releaseController(message.requestId, controller);
      }
    },
    async handleMetadataBatchMessage(
      message: FetchPullReviewerMetadataBatchMessage,
      context: RepositoryFetchContext,
    ): Promise<FetchPullReviewerMetadataBatchResponse> {
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
          account: contentAccount(result.account),
        };
      } catch (error) {
        return failure(error);
      } finally {
        releaseController(message.requestId, controller);
      }
    },
  };
}
