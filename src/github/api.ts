import { z } from "zod";

import type { ExtensionSettings } from "../storage/settings";

const pullSchema = z.object({
  user: z.object({
    login: z.string(),
  }),
  requested_reviewers: z
    .array(
      z.object({
        login: z.string(),
      }),
    )
    .default([]),
  requested_teams: z
    .array(
      z.object({
        slug: z.string(),
      }),
    )
    .default([]),
});

const pullListSchema = z.array(
  z.object({
    number: z.number(),
  }),
);

const reviewsSchema = z.array(
  z.object({
    state: z.string(),
    submitted_at: z.string().nullable().optional(),
    user: z
      .object({
        login: z.string(),
      })
      .nullable(),
  }),
);

const rateLimitSchema = z.object({
  rate: z.object({
    limit: z.number(),
    remaining: z.number(),
  }),
});

export type ReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED";

export type CompletedReview = {
  login: string;
  state: ReviewState;
};

export type PullReviewerSummary = {
  requestedUsers: string[];
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
  | "unauthenticated-rate-limit"
  | "unauthenticated-private-like"
  | "token-invalid"
  | "token-permission"
  | "token-not-found"
  | "unknown-error";

export type RepositoryValidationResult =
  | {
      ok: true;
      authMode: RepositoryValidationAuthMode;
      outcome: "accessible";
      message: string;
      fullName: string;
      pullNumber: string;
    }
  | {
      ok: false;
      authMode: RepositoryValidationAuthMode;
      outcome: Exclude<RepositoryValidationOutcome, "accessible">;
      message: string;
      fullName?: string;
      pullNumber?: string;
    };

type GitHubEndpointName = "pull" | "reviews" | "pulls-list";

type GitHubEndpointDescriptor = {
  name: GitHubEndpointName;
  method: "GET";
  path: string;
};

type GitHubRateLimitSnapshot = {
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

const errorResponseSchema = z
  .object({
    message: z.string().optional(),
  })
  .passthrough();

export function describeGitHubApiError(
  error: unknown,
  settings: ExtensionSettings,
): string {
  if (error instanceof GitHubPullRequestEndpointsError) {
    return error.failures
      .map((failure) => describeGitHubEndpointError(failure, settings))
      .join(" ");
  }

  if (error instanceof GitHubApiError) {
    return describeGitHubEndpointError(error, settings);
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown GitHub API error.";
}

export async function fetchPullReviewerSummary(input: {
  owner: string;
  repo: string;
  pullNumber: string;
  settings: ExtensionSettings;
  signal?: AbortSignal;
}): Promise<PullReviewerSummary> {
  const headers = createGitHubHeaders(input.settings.githubToken);
  const pullEndpoint = buildPullEndpoint(
    input.owner,
    input.repo,
    input.pullNumber,
  );
  const reviewsEndpoint = buildReviewsEndpoint(
    input.owner,
    input.repo,
    input.pullNumber,
  );
  const pullUrl = `https://api.github.com${pullEndpoint.path}`;
  const reviewUrl = `https://api.github.com${reviewsEndpoint.path}`;

  const [pullResponse, reviewsResponse] = await Promise.all([
    fetch(pullUrl, { headers, signal: input.signal }),
    fetch(reviewUrl, { headers, signal: input.signal }),
  ]);

  const failures = (
    await Promise.all([
      createGitHubApiErrorFromResponse(pullResponse, pullEndpoint),
      createGitHubApiErrorFromResponse(reviewsResponse, reviewsEndpoint),
    ])
  ).filter((failure): failure is GitHubApiError => failure != null);

  if (failures.length > 0) {
    throw new GitHubPullRequestEndpointsError(failures);
  }

  const pull = pullSchema.parse(await pullResponse.json());
  const reviews = reviewsSchema.parse(await reviewsResponse.json());
  const latestReviewByUser = new Map<
    string,
    { state: ReviewState; submittedAt: string | null; index: number }
  >();

  reviews.forEach((review, index) => {
    const normalizedState = normalizeReviewState(review.state);
    const reviewer = review.user?.login;

    if (
      normalizedState == null ||
      reviewer == null ||
      reviewer === pull.user.login
    ) {
      return;
    }

    const existingReview = latestReviewByUser.get(reviewer);
    if (
      existingReview == null ||
      isNewerReview(review.submitted_at ?? null, index, existingReview)
    ) {
      latestReviewByUser.set(reviewer, {
        state: normalizedState,
        submittedAt: review.submitted_at ?? null,
        index,
      });
    }
  });

  const completedReviews = Array.from(latestReviewByUser.entries())
    .map(([login, review]) => ({
      login,
      state: review.state,
    }))
    .sort((left, right) => left.login.localeCompare(right.login));

  return {
    requestedUsers: pull.requested_reviewers.map((reviewer) => reviewer.login),
    requestedTeams: pull.requested_teams.map((team) => team.slug),
    completedReviews,
  };
}

export async function validateGitHubToken(
  token: string,
): Promise<TokenValidationResult> {
  const response = await fetch("https://api.github.com/rate_limit", {
    headers: createGitHubHeaders(token),
  });

  if (!response.ok) {
    const error = await createGitHubApiError(response, {
      name: "pulls-list",
      method: "GET",
      path: "/rate_limit",
    });
    return {
      ok: false,
      message: describeGitHubApiError(error, { githubToken: token }),
    };
  }

  const payload = rateLimitSchema.parse(await response.json());
  return {
    ok: true,
    limit: payload.rate.limit,
    remaining: payload.rate.remaining,
  };
}

export async function validateGitHubRepositoryAccess(
  token: string | null,
  repository: string,
): Promise<RepositoryValidationResult> {
  const settings = createValidationSettings(token);
  const authMode = getRepositoryValidationAuthMode(settings);
  const parsedRepository = parseRepositoryReference(repository);
  if (parsedRepository == null) {
    return {
      ok: false,
      authMode,
      outcome: "invalid-repository",
      message: "Repository must use the form owner/name.",
    };
  }

  const fullName = `${parsedRepository.owner}/${parsedRepository.repo}`;
  const listEndpoint = buildPullsListEndpoint(
    parsedRepository.owner,
    parsedRepository.repo,
  );
  const response = await fetch(`https://api.github.com${listEndpoint.path}`, {
    headers: createGitHubHeaders(settings.githubToken),
  });

  if (!response.ok) {
    const error = await createGitHubApiError(response, listEndpoint);
    return {
      ok: false,
      authMode,
      outcome: classifyRepositoryValidationOutcome(error, settings),
      fullName,
      message: describeRepositoryValidationError(error, fullName, settings),
    };
  }

  const pulls = pullListSchema.parse(await response.json());
  const firstPull = pulls[0];
  if (firstPull == null) {
    return {
      ok: false,
      authMode,
      outcome: "no-pulls",
      fullName,
      message: `Repository ${fullName} has no pull requests yet, so the exact reviewer endpoints could not be checked.`,
    };
  }

  const pullNumber = String(firstPull.number);

  try {
    await fetchPullReviewerSummary({
      owner: parsedRepository.owner,
      repo: parsedRepository.repo,
      pullNumber,
      settings,
    });
  } catch (error) {
    return {
      ok: false,
      authMode,
      outcome: classifyRepositoryValidationOutcome(error, settings),
      fullName,
      pullNumber,
      message: describeRepositoryValidationError(
        error,
        fullName,
        settings,
        pullNumber,
      ),
    };
  }

  return {
    ok: true,
    authMode,
    outcome: "accessible",
    message: describeRepositoryValidationSuccess(
      fullName,
      pullNumber,
      authMode,
    ),
    fullName,
    pullNumber,
  };
}

export function parseRepositoryReference(repository: string): {
  owner: string;
  repo: string;
} | null {
  const normalized = repository
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\/+$/, "");
  const match = normalized.match(/^([^/\s]+)\/([^/\s]+)$/);

  if (match == null) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
  };
}

function createGitHubHeaders(token?: string | null): Headers {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return headers;
}

async function createGitHubApiErrorFromResponse(
  response: Response,
  endpoint: GitHubEndpointDescriptor,
): Promise<GitHubApiError | null> {
  if (response.ok) {
    return null;
  }

  return createGitHubApiError(response, endpoint);
}

async function createGitHubApiError(
  response: Response,
  endpoint?: GitHubEndpointDescriptor,
): Promise<GitHubApiError> {
  const payload = errorResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  return new GitHubApiError(
    response.status,
    payload.success ? payload.data.message : undefined,
    endpoint,
    readRateLimitSnapshot(response),
  );
}

function normalizeReviewState(state: string): ReviewState | null {
  const normalized = state.toUpperCase();

  if (
    normalized === "APPROVED" ||
    normalized === "CHANGES_REQUESTED" ||
    normalized === "COMMENTED" ||
    normalized === "DISMISSED"
  ) {
    return normalized;
  }

  return null;
}

function isNewerReview(
  submittedAt: string | null,
  index: number,
  existing: { submittedAt: string | null; index: number },
): boolean {
  if (submittedAt && existing.submittedAt) {
    return submittedAt >= existing.submittedAt;
  }

  if (submittedAt && !existing.submittedAt) {
    return true;
  }

  if (!submittedAt && existing.submittedAt) {
    return false;
  }

  return index >= existing.index;
}

function describeRepositoryValidationError(
  error: unknown,
  repository: string,
  settings: ExtensionSettings,
  pullNumber?: string,
): string {
  const message = describeGitHubApiError(error, settings);
  if (pullNumber) {
    return `Repository diagnostics checked pull #${pullNumber} in ${repository}. ${message}`;
  }

  return `Repository diagnostics failed for ${repository}. ${message}`;
}

function describeRepositoryValidationSuccess(
  repository: string,
  pullNumber: string,
  authMode: RepositoryValidationAuthMode,
): string {
  const credentialLabel =
    authMode === "no-token" ? "without a token" : "with the saved token";

  return `Repository diagnostics checked pull #${pullNumber} in ${repository}. GET /repos/${repository}/pulls/${pullNumber} and /reviews both passed ${credentialLabel}.`;
}

function describeGitHubEndpointError(
  error: GitHubApiError,
  settings: ExtensionSettings,
): string {
  const endpointLabel = formatEndpointLabel(error.endpoint);
  const rateLimitSuffix = formatRateLimitSuffix(error.rateLimit);

  if (settings.githubToken) {
    if (error.status === 401) {
      return error.endpoint == null || error.endpoint.path === "/rate_limit"
        ? "Saved token is invalid or expired."
        : `Saved token was rejected by ${endpointLabel}.`;
    }

    if (isRateLimitError(error)) {
      return `${endpointLabel} hit GitHub's API rate limit${rateLimitSuffix}.`;
    }

    if (error.status === 403) {
      return `GitHub denied ${endpointLabel}. Check that the token has Pull requests: Read and includes this repository.`;
    }

    if (error.status === 404) {
      return `${endpointLabel} is not accessible with the current token. Confirm the repository is selected in the token and the pull request exists.`;
    }
  } else {
    if (isRateLimitError(error)) {
      return `${endpointLabel} hit GitHub's unauthenticated rate limit${rateLimitSuffix}. Public repositories usually work without a token until that limit is exhausted; add a token for higher limits.`;
    }

    if (error.status === 401) {
      return `${endpointLabel} requires authentication. Public repositories usually work without a token, so this repository or pull request may be private or access-restricted.`;
    }

    if (error.status === 403) {
      return `${endpointLabel} was denied without a token. Public repositories usually work without a token; add a token for private repositories or higher API limits.`;
    }

    if (error.status === 404) {
      return `${endpointLabel} was not accessible without a token. Public repositories usually work without a token, so the repository or pull request may be private, deleted, or permission-gated.`;
    }
  }

  if (error.details) {
    return `${endpointLabel} failed: ${error.details}`;
  }

  return `${endpointLabel} failed with status ${error.status}.`;
}

function buildPullEndpoint(
  owner: string,
  repo: string,
  pullNumber: string,
): GitHubEndpointDescriptor {
  return {
    name: "pull",
    method: "GET",
    path: `/repos/${owner}/${repo}/pulls/${pullNumber}`,
  };
}

function buildReviewsEndpoint(
  owner: string,
  repo: string,
  pullNumber: string,
): GitHubEndpointDescriptor {
  return {
    name: "reviews",
    method: "GET",
    path: `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
  };
}

function buildPullsListEndpoint(
  owner: string,
  repo: string,
): GitHubEndpointDescriptor {
  return {
    name: "pulls-list",
    method: "GET",
    path: `/repos/${owner}/${repo}/pulls?per_page=1&state=all`,
  };
}

function formatEndpointLabel(endpoint?: GitHubEndpointDescriptor): string {
  if (endpoint == null) {
    return "GitHub API request";
  }

  return `${endpoint.method} ${endpoint.path}`;
}

function readRateLimitSnapshot(response: Response): GitHubRateLimitSnapshot {
  return {
    limit: readHeaderNumber(response.headers, "x-ratelimit-limit"),
    remaining: readHeaderNumber(response.headers, "x-ratelimit-remaining"),
    resource: response.headers.get("x-ratelimit-resource"),
    resetAt: readHeaderNumber(response.headers, "x-ratelimit-reset"),
  };
}

function readHeaderNumber(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value == null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function isRateLimitError(error: GitHubApiError): boolean {
  return (
    error.status === 429 ||
    error.rateLimit?.remaining === 0 ||
    error.details?.toLowerCase().includes("rate limit") === true
  );
}

function formatRateLimitSuffix(rateLimit?: GitHubRateLimitSnapshot): string {
  if (rateLimit?.remaining == null || rateLimit.limit == null) {
    return "";
  }

  return ` (${rateLimit.remaining}/${rateLimit.limit} remaining)`;
}

function createValidationSettings(token: string | null): ExtensionSettings {
  return {
    githubToken: token?.trim() || null,
  };
}

function getRepositoryValidationAuthMode(
  settings: ExtensionSettings,
): RepositoryValidationAuthMode {
  return settings.githubToken ? "token" : "no-token";
}

function classifyRepositoryValidationOutcome(
  error: unknown,
  settings: ExtensionSettings,
): Exclude<RepositoryValidationOutcome, "accessible"> {
  const primaryError = getPrimaryGitHubApiError(error);

  if (settings.githubToken) {
    if (primaryError?.status === 401) {
      return "token-invalid";
    }

    if (primaryError?.status === 403 && !isRateLimitError(primaryError)) {
      return "token-permission";
    }

    if (primaryError?.status === 404) {
      return "token-not-found";
    }

    return "unknown-error";
  }

  if (primaryError && isRateLimitError(primaryError)) {
    return "unauthenticated-rate-limit";
  }

  if (
    primaryError?.status === 401 ||
    primaryError?.status === 403 ||
    primaryError?.status === 404
  ) {
    return "unauthenticated-private-like";
  }

  return "unknown-error";
}

function getPrimaryGitHubApiError(error: unknown): GitHubApiError | null {
  if (error instanceof GitHubPullRequestEndpointsError) {
    return (
      error.failures.find((failure) => isRateLimitError(failure)) ??
      error.failures[0] ??
      null
    );
  }

  if (error instanceof GitHubApiError) {
    return error;
  }

  return null;
}
