import type {
  PullReviewerMetadata,
  PullReviewerSummary,
} from "../../github/api";
import type { RefreshAccountInstallationsResponse } from "../../runtime/installation-refresh";
import {
  ReviewerFetchRuntimeError,
  extractReviewerFetchFailures,
  type FetchPullReviewerMetadataBatchResponse,
  type FetchPullReviewerSummaryResponse,
} from "../../runtime/reviewer-fetch";
import type { Account } from "../../storage/accounts";

export async function fetchReviewerSummary(args: {
  account: Account | null;
  owner: string;
  repo: string;
  pullNumber: string;
  pullMetadata?: PullReviewerMetadata;
  signal: AbortSignal;
}): Promise<PullReviewerSummary> {
  const { account, owner, repo, pullNumber, pullMetadata, signal } = args;

  if (signal.aborted) {
    throw createAbortError();
  }

  const requestId = createReviewerFetchRequestId();
  const responsePromise = browser.runtime.sendMessage({
    type: "fetchPullReviewerSummary",
    requestId,
    owner,
    repo,
    pullNumber,
    accountId: account?.id ?? null,
    ...(pullMetadata == null ? {} : { pullMetadata }),
  }) as Promise<FetchPullReviewerSummaryResponse | undefined>;

  const abortListenerController = new AbortController();
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      void browser.runtime
        .sendMessage({
          type: "cancelPullReviewerSummary",
          requestId,
        })
        .catch(() => undefined);
      reject(createAbortError());
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, {
      once: true,
      signal: abortListenerController.signal,
    });
  });

  try {
    const response = await Promise.race([responsePromise, abortPromise]);
    return unwrapReviewerFetchResponse(response);
  } finally {
    abortListenerController.abort();
  }
}

export async function fetchReviewerMetadataBatch(args: {
  account: Account | null;
  owner: string;
  repo: string;
  targetPullNumbers: string[];
  signal: AbortSignal;
}): Promise<PullReviewerMetadata[]> {
  const { account, owner, repo, signal, targetPullNumbers } = args;

  if (signal.aborted) {
    throw createAbortError();
  }

  const requestId = createReviewerFetchRequestId();
  const responsePromise = browser.runtime.sendMessage({
    type: "fetchPullReviewerMetadataBatch",
    requestId,
    owner,
    repo,
    accountId: account?.id ?? null,
    targetPullNumbers,
  }) as Promise<FetchPullReviewerMetadataBatchResponse | undefined>;

  const abortListenerController = new AbortController();
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      void browser.runtime
        .sendMessage({
          type: "cancelPullReviewerSummary",
          requestId,
        })
        .catch(() => undefined);
      reject(createAbortError());
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, {
      once: true,
      signal: abortListenerController.signal,
    });
  });

  try {
    const response = await Promise.race([responsePromise, abortPromise]);
    return unwrapReviewerMetadataBatchResponse(response);
  } finally {
    abortListenerController.abort();
  }
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
  return extractReviewerFetchFailures(error).some((failure) => {
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
    throw new ReviewerFetchRuntimeError(response.error);
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
    throw new ReviewerFetchRuntimeError(response.error);
  }

  throw new Error("Background reviewer metadata fetch failed.");
}

export async function requestInstallationsRefresh(
  accountId: string,
): Promise<boolean> {
  try {
    const response = (await browser.runtime.sendMessage({
      type: "refreshAccountInstallations",
      accountId,
    })) as RefreshAccountInstallationsResponse;
    return response?.ok === true;
  } catch {
    return false;
  }
}
