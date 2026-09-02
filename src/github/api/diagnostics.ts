import { pullListSchema, rateLimitSchema } from "./schemas";
import {
  createGitHubApiError,
  createGitHubHeaders,
  fetchGitHubApiResponse,
} from "./request";
import { fetchPullReviewerSummary } from "./reviewer-summary";
import {
  GitHubApiError,
  GitHubApiSchemaError,
  GitHubPullRequestEndpointsError,
  type GitHubAuthContext,
  type GitHubEndpointDescriptor,
  type GitHubRateLimitSnapshot,
  type RepositoryValidationAuthMode,
  type RepositoryValidationFailureEvidence,
  type RepositoryValidationOutcome,
  type RepositoryValidationResult,
  type TokenValidationResult,
} from "./types";

export function describeGitHubApiError(
  error: unknown,
  auth: GitHubAuthContext,
): string {
  if (error instanceof GitHubPullRequestEndpointsError) {
    return error.failures
      .map((failure) => describeGitHubEndpointError(failure, auth))
      .join(" ");
  }

  if (error instanceof GitHubApiError) {
    return describeGitHubEndpointError(error, auth);
  }

  if (error instanceof GitHubApiSchemaError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown GitHub API error.";
}

export async function validateAccountToken(
  account: { token: string } | null,
): Promise<TokenValidationResult> {
  if (account == null) {
    return {
      ok: false,
      message:
        "No account provided — sign in with GitHub from the options page.",
    };
  }
  const rateLimitEndpoint: GitHubEndpointDescriptor = {
    name: "pulls-list",
    method: "GET",
    path: "/rate_limit",
  };
  const response = await fetchGitHubApiResponse(
    "https://api.github.com/rate_limit",
    createGitHubHeaders(account.token),
  );
  if (!response.ok) {
    const error = await createGitHubApiError(response, rateLimitEndpoint);
    return {
      ok: false,
      message: describeGitHubApiError(error, { githubToken: account.token }),
    };
  }
  const parsed = rateLimitSchema.safeParse(await response.json());
  if (!parsed.success) {
    const schemaError = new GitHubApiSchemaError(
      rateLimitEndpoint,
      parsed.error.issues,
    );
    return {
      ok: false,
      message: describeGitHubApiError(schemaError, {
        githubToken: account.token,
      }),
    };
  }
  return {
    ok: true,
    limit: parsed.data.rate.limit,
    remaining: parsed.data.rate.remaining,
  };
}

export async function validateGitHubRepositoryAccess(
  account: { token: string } | null,
  repository: string,
): Promise<RepositoryValidationResult> {
  const token = account?.token ?? null;
  const auth = createAuthContext(token);
  const authMode = getRepositoryValidationAuthMode(auth);
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
  const response = await fetchGitHubApiResponse(
    `https://api.github.com${listEndpoint.path}`,
    createGitHubHeaders(auth.githubToken),
  );

  if (!response.ok) {
    const error = await createGitHubApiError(response, listEndpoint);
    return {
      ok: false,
      authMode,
      outcome: classifyRepositoryValidationOutcome(error, auth),
      fullName,
      message: describeRepositoryValidationError(error, fullName, auth),
      ...getRepositoryValidationFailureEvidence(error),
    };
  }

  const parsedPulls = pullListSchema.safeParse(await response.json());
  if (!parsedPulls.success) {
    const schemaError = new GitHubApiSchemaError(
      listEndpoint,
      parsedPulls.error.issues,
    );
    return {
      ok: false,
      authMode,
      outcome: classifyRepositoryValidationOutcome(schemaError, auth),
      fullName,
      message: describeRepositoryValidationError(schemaError, fullName, auth),
    };
  }
  const pulls = parsedPulls.data;
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
      githubToken: auth.githubToken,
    });
  } catch (error) {
    return {
      ok: false,
      authMode,
      outcome: classifyRepositoryValidationOutcome(error, auth),
      fullName,
      pullNumber,
      message: describeRepositoryValidationError(
        error,
        fullName,
        auth,
        pullNumber,
      ),
      ...getRepositoryValidationFailureEvidence(error),
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

function describeRepositoryValidationError(
  error: unknown,
  repository: string,
  auth: GitHubAuthContext,
  pullNumber?: string,
): string {
  const message = describeGitHubApiError(error, auth);
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
  auth: GitHubAuthContext,
): string {
  const endpointLabel = formatEndpointLabel(error.endpoint);
  const rateLimitSuffix = formatRateLimitSuffix(error.rateLimit);

  if (auth.githubToken) {
    if (error.status === 401) {
      if (error.endpoint == null || error.endpoint.path === "/rate_limit") {
        return "Sign in again — the account's access was rejected by GitHub.";
      }
      return `Sign in again — ${endpointLabel} was rejected by GitHub.`;
    }

    if (isRateLimitError(error)) {
      return `${endpointLabel} hit GitHub's API rate limit${rateLimitSuffix}.`;
    }

    if (error.status === 403) {
      return `GitHub denied ${endpointLabel}. The GitHub App needs access to this repository — install the GitHub App on the owner account or add this repository to the existing installation.`;
    }

    if (error.status === 404) {
      return `${endpointLabel} is not covered by any installation of this GitHub App. Install the App on the repository owner or add the repository to the existing installation.`;
    }
  } else {
    if (isRateLimitError(error)) {
      return `${endpointLabel} hit GitHub's unauthenticated rate limit${rateLimitSuffix}. Public repositories usually work without signing in until the rate limit is exhausted; sign in for higher limits.`;
    }

    if (error.status === 401) {
      return `${endpointLabel} requires authentication. Public repositories usually work without signing in, so this repository or pull request may be private or access-restricted.`;
    }

    if (error.status === 403) {
      return `${endpointLabel} was denied without a signed-in account. Public repositories usually work without signing in; sign in for private repositories or higher API limits.`;
    }

    if (error.status === 404) {
      return `${endpointLabel} was not accessible without a signed-in account. Public repositories usually work without signing in, so the repository or pull request may be private, deleted, or permission-gated.`;
    }
  }

  if (error.details) {
    return `${endpointLabel} failed: ${error.details}`;
  }

  return `${endpointLabel} failed with status ${error.status}.`;
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

const RATE_LIMIT_MESSAGE_PATTERN = /\b(?:api|secondary) rate limit\b/i;

export function isRateLimitError(error: GitHubApiError): boolean {
  return (
    error.status === 429 ||
    error.rateLimit?.remaining === 0 ||
    (error.details != null && RATE_LIMIT_MESSAGE_PATTERN.test(error.details))
  );
}

function formatRateLimitSuffix(rateLimit?: GitHubRateLimitSnapshot): string {
  if (rateLimit?.remaining == null || rateLimit.limit == null) {
    return "";
  }

  return ` (${rateLimit.remaining}/${rateLimit.limit} remaining)`;
}

function createAuthContext(token: string | null): GitHubAuthContext {
  return {
    githubToken: token?.trim() || null,
  };
}

function getRepositoryValidationAuthMode(
  auth: GitHubAuthContext,
): RepositoryValidationAuthMode {
  return auth.githubToken ? "token" : "no-token";
}

function classifyRepositoryValidationOutcome(
  error: unknown,
  auth: GitHubAuthContext,
): Exclude<RepositoryValidationOutcome, "accessible"> {
  const primaryError = getPrimaryGitHubApiError(error);

  if (auth.githubToken) {
    if (primaryError && isRateLimitError(primaryError)) {
      return "authenticated-rate-limit";
    }

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

function getRepositoryValidationFailureEvidence(
  error: unknown,
): RepositoryValidationFailureEvidence {
  const primaryError = getPrimaryGitHubApiError(error);
  if (primaryError == null) {
    return {};
  }

  return {
    ...(primaryError.endpoint == null
      ? {}
      : { endpoint: primaryError.endpoint }),
    httpStatus: primaryError.status,
    ...(hasRateLimitEvidence(primaryError.rateLimit)
      ? { rateLimit: primaryError.rateLimit }
      : {}),
  };
}

function hasRateLimitEvidence(
  rateLimit: GitHubRateLimitSnapshot | undefined,
): rateLimit is GitHubRateLimitSnapshot {
  return (
    rateLimit != null &&
    (rateLimit.limit != null ||
      rateLimit.remaining != null ||
      rateLimit.resource != null ||
      rateLimit.resetAt != null)
  );
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
