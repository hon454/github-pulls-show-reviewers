import {
  GitHubApiError,
  GitHubApiSchemaError,
  GitHubPullRequestEndpointsError,
  extractGitHubApiStatus,
  type PullReviewerSummary,
} from "../github/api";

export type FetchPullReviewerSummaryMessage = {
  type: "fetchPullReviewerSummary";
  owner: string;
  repo: string;
  pullNumber: string;
  accountId: string | null;
};

export type ReviewerFetchFailure = {
  status: number;
  endpoint: string | null;
};

export type ReviewerFetchErrorEnvelope = {
  kind: "github-api" | "github-endpoints" | "schema" | "unknown";
  status: number | null;
  failures?: ReviewerFetchFailure[];
  message?: string;
};

export type FetchPullReviewerSummaryResponse =
  | {
      ok: true;
      summary: PullReviewerSummary;
    }
  | {
      ok: false;
      error: ReviewerFetchErrorEnvelope;
    };

export function isFetchPullReviewerSummaryMessage(
  value: unknown,
): value is FetchPullReviewerSummaryMessage {
  return (
    value != null &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "fetchPullReviewerSummary" &&
    typeof (value as { owner?: unknown }).owner === "string" &&
    typeof (value as { repo?: unknown }).repo === "string" &&
    typeof (value as { pullNumber?: unknown }).pullNumber === "string" &&
    (((value as { accountId?: unknown }).accountId === null) ||
      typeof (value as { accountId?: unknown }).accountId === "string")
  );
}

export function serializeReviewerFetchError(
  error: unknown,
): ReviewerFetchErrorEnvelope {
  if (error instanceof GitHubPullRequestEndpointsError) {
    return {
      kind: "github-endpoints",
      status: extractGitHubApiStatus(error),
      failures: error.failures.map((failure) => ({
        status: failure.status,
        endpoint: failure.endpoint?.path ?? null,
      })),
      message: error.message,
    };
  }

  if (error instanceof GitHubApiError) {
    return {
      kind: "github-api",
      status: error.status,
      failures: [
        {
          status: error.status,
          endpoint: error.endpoint?.path ?? null,
        },
      ],
      message: error.message,
    };
  }

  if (error instanceof GitHubApiSchemaError) {
    return {
      kind: "schema",
      status: null,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      kind: "unknown",
      status: extractGitHubApiStatus(error),
      message: error.message,
    };
  }

  return {
    kind: "unknown",
    status: extractGitHubApiStatus(error),
  };
}

export function extractReviewerFetchFailures(
  error: unknown,
): ReviewerFetchFailure[] {
  if (error instanceof GitHubPullRequestEndpointsError) {
    return error.failures.map((failure) => ({
      status: failure.status,
      endpoint: failure.endpoint?.path ?? null,
    }));
  }

  if (error instanceof GitHubApiError) {
    return [
      {
        status: error.status,
        endpoint: error.endpoint?.path ?? null,
      },
    ];
  }

  if (
    error != null &&
    typeof error === "object" &&
    "failures" in error &&
    Array.isArray((error as { failures: unknown }).failures)
  ) {
    return (error as { failures: Array<{ status?: unknown; endpoint?: unknown }> }).failures
      .filter(
        (failure): failure is { status: number; endpoint?: string | null } =>
          typeof failure?.status === "number",
      )
      .map((failure) => ({
        status: failure.status,
        endpoint:
          typeof failure.endpoint === "string" ? failure.endpoint : null,
      }));
  }

  if (
    error != null &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    return [
      {
        status: (error as { status: number }).status,
        endpoint: null,
      },
    ];
  }

  return [];
}
