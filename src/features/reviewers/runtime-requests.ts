import {
  createReviewerDeadline,
  REVIEWER_DEADLINES,
  ReviewerTimeoutError,
  throwIfReviewerAborted,
} from "../../shared/reviewer-deadline";
import type {
  PullReviewerMetadata,
  PullReviewerSummary,
} from "../../github/api";
import {
  ReviewerFetchRuntimeError,
  serializeReviewerFetchError,
  type FetchPullReviewerSummaryMessage,
  type FetchPullReviewerMetadataBatchMessage,
  extractReviewerFetchFailures,
  fetchPullReviewerMetadataBatchResponseSchema,
  fetchPullReviewerSummaryResponseSchema,
  type FetchPullReviewerMetadataBatchResponse,
  type FetchPullReviewerSummaryResponse,
} from "../../runtime/reviewer-fetch";
import type { AccountSummary as Account } from "../../runtime/ui-contract";

export async function fetchReviewerSummary(args: {
  account: Account | null;
  owner: string;
  repo: string;
  pullNumber: string;
  pullMetadata?: PullReviewerMetadata;
  signal: AbortSignal;
  discoveryId?: string;
  onAccount?: (account: Account | null) => void;
}): Promise<PullReviewerSummary> {
  const { account, owner, repo, pullNumber, pullMetadata, signal } = args;

  if (signal.aborted) {
    throw createAbortError();
  }

  const requestId = createReviewerFetchRequestId();
  const response = await sendReviewerRequest(
    {
      type: "fetchPullReviewerSummary",
      requestId,
      owner,
      repo,
      pullNumber,
      accountId: account?.id ?? null,
      ...(args.discoveryId
        ? {
            discoveryId: args.discoveryId,
            ...(account ? { accountRevision: account.revision } : {}),
          }
        : {}),
      ...(pullMetadata == null ? {} : { pullMetadata }),
    },
    signal,
  );

  throwIfReviewerAborted(signal);
  const parsed = fetchPullReviewerSummaryResponseSchema.parse(response);
  if (parsed.account !== undefined) args.onAccount?.(parsed.account);
  return unwrapReviewerFetchResponse(parsed);
}

export async function fetchReviewerMetadataBatch(args: {
  account: Account | null;
  owner: string;
  repo: string;
  targetPullNumbers: string[];
  refresh?: boolean;
  signal: AbortSignal;
  discoveryId?: string;
  onAccount?: (account: Account | null) => void;
}): Promise<PullReviewerMetadata[]> {
  const { account, owner, repo, signal, targetPullNumbers } = args;

  if (signal.aborted) {
    throw createAbortError();
  }

  const requestId = createReviewerFetchRequestId();
  const response = await sendReviewerRequest(
    {
      type: "fetchPullReviewerMetadataBatch",
      requestId,
      owner,
      repo,
      accountId: account?.id ?? null,
      ...(args.discoveryId ? { discoveryId: args.discoveryId } : {}),
      targetPullNumbers,
      ...(args.refresh ? { refresh: true } : {}),
    },
    signal,
  );

  throwIfReviewerAborted(signal);
  const parsed = fetchPullReviewerMetadataBatchResponseSchema.parse(response);
  if (parsed.account !== undefined) args.onAccount?.(parsed.account);
  return unwrapReviewerMetadataBatchResponse(parsed);
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (
    error != null &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  ) {
    return true;
  }
  return false;
}

export function shouldRetryWithFallbackAccount(error: unknown): boolean {
  const failures = extractReviewerFetchFailures(error);
  if (failures.some((failure) => failure.kind === "timeout")) return false;
  return failures.some((failure) => {
    if (failure.rateLimited || failure.status === 429) {
      return true;
    }
    return (
      failure.status === 401 || failure.status === 403 || failure.status === 404
    );
  });
}

let reviewerFetchRequestCounter = 0;

function createReviewerFetchRequestId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `reviewer-fetch-${globalThis.crypto.randomUUID()}`;
  }

  reviewerFetchRequestCounter += 1;
  return `reviewer-fetch-${Date.now()}-${reviewerFetchRequestCounter}`;
}

function createAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }

  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function unwrapReviewerFetchResponse(
  response: FetchPullReviewerSummaryResponse | undefined,
): PullReviewerSummary {
  if (response?.ok === true) {
    return response.summary;
  }

  if (response?.ok === false) {
    throw new ReviewerFetchRuntimeError(response.error, response.account);
  }

  throw new Error("Background reviewer fetch failed.");
}

function unwrapReviewerMetadataBatchResponse(
  response: FetchPullReviewerMetadataBatchResponse | undefined,
): PullReviewerMetadata[] {
  if (response?.ok === true) {
    return response.metadata;
  }

  if (response?.ok === false) {
    throw new ReviewerFetchRuntimeError(response.error, response.account);
  }

  throw new Error("Background reviewer metadata fetch failed.");
}

/** Starts only when the scheduler actually dispatches the RPC. */
async function sendReviewerRequest(
  message:
    | FetchPullReviewerSummaryMessage
    | FetchPullReviewerMetadataBatchMessage,
  signal: AbortSignal,
): Promise<unknown> {
  const deadline = createReviewerDeadline(REVIEWER_DEADLINES.rpc, signal);
  const cancel = () => {
    // Cancellation is best effort even if the worker vanished or throws sync.
    void Promise.resolve()
      .then(() =>
        browser.runtime.sendMessage({
          type: "cancelPullReviewerSummary",
          requestId: message.requestId,
        }),
      )
      .catch(() => undefined);
  };
  try {
    throwIfReviewerAborted(deadline.signal);
    deadline.signal.addEventListener("abort", cancel, { once: true });
    return await deadline.wait(browser.runtime.sendMessage(message));
  } catch (error) {
    if (error instanceof ReviewerTimeoutError)
      throw new ReviewerFetchRuntimeError(serializeReviewerFetchError(error));
    throw error;
  } finally {
    deadline.signal.removeEventListener("abort", cancel);
    deadline.dispose();
  }
}
