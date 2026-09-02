export type GitHubAuthContext = {
  githubToken: string | null;
};

export type PullReviewerSummaryStatus =
  | "ok"
  | "no-coverage"
  | "network-error"
  | "rate-limited";

export type ReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED";

export type ReviewerUser = { login: string; avatarUrl: string | null };

export type CompletedReview = ReviewerUser & { state: ReviewState };

export type PullReviewerMetadata = {
  number: string;
  authorLogin: string;
  requestedUsers: ReviewerUser[];
  requestedTeams: string[];
};

export type PullReviewerSummary = {
  status: PullReviewerSummaryStatus;
  requestedUsers: ReviewerUser[];
  requestedTeams: string[];
  completedReviews: CompletedReview[];
};

export type TokenValidationResult =
  | {
      ok: true;
      limit: number;
      remaining: number;
    }
  | {
      ok: false;
      message: string;
    };

export type RepositoryValidationAuthMode = "token" | "no-token";

export type RepositoryValidationOutcome =
  | "accessible"
  | "invalid-repository"
  | "no-pulls"
  | "authenticated-rate-limit"
  | "unauthenticated-rate-limit"
  | "unauthenticated-private-like"
  | "token-invalid"
  | "token-permission"
  | "token-not-found"
  | "unknown-error";

export type RepositoryValidationFailureEvidence = {
  endpoint?: GitHubEndpointDescriptor;
  httpStatus?: number;
  rateLimit?: GitHubRateLimitSnapshot;
};

export type RepositoryValidationResult =
  | ({
      ok: true;
      authMode: RepositoryValidationAuthMode;
      outcome: "accessible";
      message: string;
      fullName: string;
      pullNumber: string;
    } & RepositoryValidationFailureEvidence)
  | ({
      ok: false;
      authMode: RepositoryValidationAuthMode;
      outcome: Exclude<RepositoryValidationOutcome, "accessible">;
      message: string;
      fullName?: string;
      pullNumber?: string;
    } & RepositoryValidationFailureEvidence);

export type GitHubEndpointName =
  | "pull"
  | "reviews"
  | "issue-events"
  | "pulls-list";

export type GitHubEndpointDescriptor = {
  name: GitHubEndpointName;
  method: "GET";
  path: string;
};

export type GitHubRateLimitSnapshot = {
  limit: number | null;
  remaining: number | null;
  resource: string | null;
  resetAt: number | null;
};

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly details?: string,
    public readonly endpoint?: GitHubEndpointDescriptor,
    public readonly rateLimit?: GitHubRateLimitSnapshot,
  ) {
    super(`GitHub API request failed with status ${status}.`);
    this.name = "GitHubApiError";
  }
}

export class GitHubPullRequestEndpointsError extends Error {
  constructor(public readonly failures: GitHubApiError[]) {
    super("GitHub pull request endpoint diagnostics failed.");
    this.name = "GitHubPullRequestEndpointsError";
  }
}

export class GitHubApiSchemaError extends Error {
  constructor(
    public readonly endpoint: GitHubEndpointDescriptor,
    public readonly issues?: unknown,
  ) {
    super(
      `GitHub returned an unexpected response shape for ${endpoint.method} ${endpoint.path}.`,
    );
    this.name = "GitHubApiSchemaError";
  }
}

export function extractGitHubApiStatus(error: unknown): number | null {
  if (error instanceof GitHubApiError) {
    return error.status;
  }
  if (error instanceof GitHubPullRequestEndpointsError) {
    const first = error.failures[0];
    return first?.status ?? null;
  }
  if (error && typeof error === "object" && "status" in error) {
    const value = (error as { status: unknown }).status;
    return typeof value === "number" ? value : null;
  }
  if (
    error &&
    typeof error === "object" &&
    "failures" in error &&
    Array.isArray((error as { failures: unknown }).failures)
  ) {
    const first = (error as { failures: Array<{ status?: number }> })
      .failures[0];
    return typeof first?.status === "number" ? first.status : null;
  }
  if (error instanceof Error) {
    const match = /status (\d+)/i.exec(error.message);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}
