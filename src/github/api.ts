import { z } from "zod";

import { withOptionalSignal } from "./request-init";

type GitHubAuthContext = {
  githubToken: string | null;
};

const avatarUrlField = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Avatar URL must be http(s)")
  .nullable()
  .optional()
  .catch(null);

const userLiteSchema = z.object({
  login: z.string(),
  avatar_url: avatarUrlField,
});

const pullSchema = z.object({
  user: z.object({
    login: z.string(),
  }),
  requested_reviewers: z.array(userLiteSchema).default([]),
  requested_teams: z
    .array(
      z.object({
        slug: z.string(),
      }),
    )
    .default([]),
});

const pullReviewerMetadataSchema = pullSchema.extend({
  number: z.number(),
});

const pullReviewerMetadataListSchema = z.array(pullReviewerMetadataSchema);
const MAX_PULL_METADATA_BATCH_PAGES = 3;
const MAX_REVIEW_REQUEST_EVENT_PAGES = 2;

const pullListSchema = z.array(
  z.object({
    number: z.number(),
  }),
);

const reviewsSchema = z.array(
  z.object({
    state: z.string(),
    submitted_at: z.string().nullable().optional(),
    user: userLiteSchema.nullable(),
  }),
);

const reviewRequestEventsSchema = z.array(
  z.object({
    event: z.string(),
    created_at: z.string(),
    requested_reviewer: userLiteSchema.nullable().optional(),
  }),
);

const rateLimitSchema = z.object({
  rate: z.object({
    limit: z.number(),
    remaining: z.number(),
  }),
});

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

type GitHubEndpointName = "pull" | "reviews" | "issue-events" | "pulls-list";

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

type LatestNonCommentReview = {
  state: Exclude<ReviewState, "COMMENTED">;
  avatarUrl: string | null;
  submittedAt: string | null;
  index: number;
};

type LatestCommentReview = {
  avatarUrl: string | null;
  submittedAt: string | null;
  index: number;
};

type LatestReviewEvidence = {
  latestNonCommentByUser: Map<string, LatestNonCommentReview>;
  latestCommentByUser: Map<string, LatestCommentReview>;
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

const errorResponseSchema = z
  .object({
    message: z.string().optional(),
  })
  .passthrough();

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

function normalizeAvatarUrl(raw: string | null | undefined): string | null {
  return raw ?? null;
}

export async function fetchPullReviewerSummary(input: {
  owner: string;
  repo: string;
  pullNumber: string;
  githubToken: string | null;
  pullMetadata?: PullReviewerMetadata;
  signal?: AbortSignal;
}): Promise<PullReviewerSummary> {
  const headers = createGitHubHeaders(input.githubToken);
  const reviewsEndpoint = buildReviewsEndpoint(
    input.owner,
    input.repo,
    input.pullNumber,
  );
  const reviewsFirstPageUrl = `https://api.github.com${reviewsEndpoint.path}?per_page=100`;

  if (input.pullMetadata != null) {
    const reviewsFirstResponse = await fetch(
      reviewsFirstPageUrl,
      withOptionalSignal({ headers }, input.signal),
    );

    const failure = await createGitHubApiErrorFromResponse(
      reviewsFirstResponse,
      reviewsEndpoint,
    );
    if (failure != null) {
      throw new GitHubPullRequestEndpointsError([failure]);
    }

    const reviews = await collectReviewsAcrossPages({
      firstResponse: reviewsFirstResponse,
      endpoint: reviewsEndpoint,
      headers,
      ...(input.signal == null ? {} : { signal: input.signal }),
    });

    const latestReviewEvidence = collectLatestReviewEvidence(
      input.pullMetadata,
      reviews,
    );
    const latestReviewRequestByLogin =
      await fetchLatestReviewRequestEventsForAmbiguousReviewers({
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pullNumber,
        pullMetadata: input.pullMetadata,
        latestNonCommentByUser: latestReviewEvidence.latestNonCommentByUser,
        headers,
        ...(input.signal == null ? {} : { signal: input.signal }),
      });

    return buildPullReviewerSummary(
      input.pullMetadata,
      latestReviewEvidence,
      latestReviewRequestByLogin,
    );
  }

  const pullEndpoint = buildPullEndpoint(
    input.owner,
    input.repo,
    input.pullNumber,
  );
  const pullUrl = `https://api.github.com${pullEndpoint.path}`;

  const [pullResponse, reviewsFirstResponse] = await Promise.all([
    fetch(pullUrl, withOptionalSignal({ headers }, input.signal)),
    fetch(reviewsFirstPageUrl, withOptionalSignal({ headers }, input.signal)),
  ]);

  const failures = (
    await Promise.all([
      createGitHubApiErrorFromResponse(pullResponse, pullEndpoint),
      createGitHubApiErrorFromResponse(reviewsFirstResponse, reviewsEndpoint),
    ])
  ).filter((failure): failure is GitHubApiError => failure != null);

  if (failures.length > 0) {
    throw new GitHubPullRequestEndpointsError(failures);
  }

  const pullParsed = pullSchema.safeParse(await pullResponse.json());
  if (!pullParsed.success) {
    throw new GitHubApiSchemaError(pullEndpoint, pullParsed.error.issues);
  }

  const reviews = await collectReviewsAcrossPages({
    firstResponse: reviewsFirstResponse,
    endpoint: reviewsEndpoint,
    headers,
    ...(input.signal == null ? {} : { signal: input.signal }),
  });

  const pullMetadata = toPullReviewerMetadata(input.pullNumber, pullParsed.data);
  const latestReviewEvidence = collectLatestReviewEvidence(pullMetadata, reviews);
  const latestReviewRequestByLogin =
    await fetchLatestReviewRequestEventsForAmbiguousReviewers({
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.pullNumber,
      pullMetadata,
      latestNonCommentByUser: latestReviewEvidence.latestNonCommentByUser,
      headers,
      ...(input.signal == null ? {} : { signal: input.signal }),
    });

  return buildPullReviewerSummary(
    pullMetadata,
    latestReviewEvidence,
    latestReviewRequestByLogin,
  );
}

export async function fetchPullReviewerMetadataBatch(input: {
  owner: string;
  repo: string;
  githubToken: string | null;
  targetPullNumbers?: string[];
  signal?: AbortSignal;
}): Promise<PullReviewerMetadata[]> {
  const headers = createGitHubHeaders(input.githubToken);
  const endpoint = buildPullsMetadataEndpoint(input.owner, input.repo);
  const response = await fetch(
    `https://api.github.com${endpoint.path}`,
    withOptionalSignal({ headers }, input.signal),
  );

  const failure = await createGitHubApiErrorFromResponse(response, endpoint);
  if (failure != null) {
    throw failure;
  }

  const pulls = await collectPullMetadataAcrossPages({
    firstResponse: response,
    endpoint,
    headers,
    targetPullNumbers: input.targetPullNumbers ?? [],
    ...(input.signal == null ? {} : { signal: input.signal }),
  });

  return pulls.map((pull) => toPullReviewerMetadata(String(pull.number), pull));
}

function buildPullReviewerSummary(
  pullMetadata: PullReviewerMetadata,
  latestReviewEvidence: LatestReviewEvidence,
  latestReviewRequestByLogin: Map<string, string> | null = null,
): PullReviewerSummary {
  const { latestNonCommentByUser, latestCommentByUser } =
    latestReviewEvidence;

  const reviewerLogins = new Set<string>([
    ...latestNonCommentByUser.keys(),
    ...latestCommentByUser.keys(),
  ]);

  const completedReviews: CompletedReview[] = Array.from(reviewerLogins)
    .map((login) => {
      const nonComment = latestNonCommentByUser.get(login);
      if (nonComment != null) {
        return {
          login,
          avatarUrl: nonComment.avatarUrl,
          state: nonComment.state as ReviewState,
        };
      }
      const comment = latestCommentByUser.get(login)!;
      return {
        login,
        avatarUrl: comment.avatarUrl,
        state: "COMMENTED" as ReviewState,
      };
    })
    .sort((left, right) => left.login.localeCompare(right.login));

  return {
    status: "ok" as const,
    requestedUsers: filterStaleRequestedUsers(
      pullMetadata.requestedUsers,
      latestNonCommentByUser,
      latestReviewRequestByLogin,
    ),
    requestedTeams: pullMetadata.requestedTeams,
    completedReviews,
  };
}

function collectLatestReviewEvidence(
  pullMetadata: PullReviewerMetadata,
  reviews: z.infer<typeof reviewsSchema>,
): LatestReviewEvidence {
  const latestNonCommentByUser = new Map<string, LatestNonCommentReview>();
  const latestCommentByUser = new Map<string, LatestCommentReview>();

  reviews.forEach((review, index) => {
    const normalizedState = normalizeReviewState(review.state);
    const reviewer = review.user?.login;

    if (
      normalizedState == null ||
      reviewer == null ||
      reviewer === pullMetadata.authorLogin
    ) {
      return;
    }

    if (normalizedState === "COMMENTED") {
      const existing = latestCommentByUser.get(reviewer);
      if (
        existing == null ||
        isNewerReview(review.submitted_at ?? null, index, existing)
      ) {
        latestCommentByUser.set(reviewer, {
          avatarUrl: normalizeAvatarUrl(review.user?.avatar_url),
          submittedAt: review.submitted_at ?? null,
          index,
        });
      }
      return;
    }

    const existing = latestNonCommentByUser.get(reviewer);
    if (
      existing == null ||
      isNewerReview(review.submitted_at ?? null, index, existing)
    ) {
      latestNonCommentByUser.set(reviewer, {
        state: normalizedState,
        avatarUrl: normalizeAvatarUrl(review.user?.avatar_url),
        submittedAt: review.submitted_at ?? null,
        index,
      });
    }
  });

  return { latestNonCommentByUser, latestCommentByUser };
}

async function fetchLatestReviewRequestEventsForAmbiguousReviewers(params: {
  owner: string;
  repo: string;
  pullNumber: string;
  pullMetadata: PullReviewerMetadata;
  latestNonCommentByUser: Map<string, LatestNonCommentReview>;
  headers: Headers;
  signal?: AbortSignal;
}): Promise<Map<string, string> | null> {
  const ambiguousLogins = params.pullMetadata.requestedUsers
    .map((user) => user.login)
    .filter((login) => params.latestNonCommentByUser.has(login));

  if (ambiguousLogins.length === 0) {
    return null;
  }

  const endpoint = buildIssueEventsEndpoint(
    params.owner,
    params.repo,
    params.pullNumber,
  );
  const firstPageUrl = `https://api.github.com${endpoint.path}?per_page=100`;

  try {
    const firstResponse = await fetch(
      firstPageUrl,
      withOptionalSignal({ headers: params.headers }, params.signal),
    );

    const failure = await createGitHubApiErrorFromResponse(firstResponse, endpoint);
    if (failure != null) {
      throw new GitHubPullRequestEndpointsError([failure]);
    }

    const events = await collectReviewRequestEventsAcrossPages({
      firstResponse,
      endpoint,
      headers: params.headers,
      ...(params.signal == null ? {} : { signal: params.signal }),
    });

    return selectLatestReviewRequestByLogin(events, new Set(ambiguousLogins));
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof GitHubApiSchemaError) {
      console.warn(error.message, error.issues);
    }
    return new Map();
  }
}

function filterStaleRequestedUsers(
  requestedUsers: ReviewerUser[],
  latestNonCommentByUser: Map<string, LatestNonCommentReview>,
  latestReviewRequestByLogin: Map<string, string> | null,
): ReviewerUser[] {
  if (latestReviewRequestByLogin == null) {
    // No requested/completed overlap existed, so the issue-events lookup was
    // intentionally skipped and every requested user remains requested.
    return requestedUsers;
  }

  // A present map means the lookup was attempted. Missing login entries are
  // treated as no confirmed re-request and drop the stale requested marker.
  return requestedUsers.filter((user) => {
    const latestReview = latestNonCommentByUser.get(user.login);
    if (latestReview == null) {
      return true;
    }

    return isReviewRequestAfterReview(
      latestReviewRequestByLogin.get(user.login) ?? null,
      latestReview.submittedAt,
    );
  });
}

function selectLatestReviewRequestByLogin(
  events: z.infer<typeof reviewRequestEventsSchema>,
  targetLogins: Set<string>,
): Map<string, string> {
  const latestByLogin = new Map<string, string>();

  for (const event of events) {
    if (event.event !== "review_requested") {
      continue;
    }
    const login = event.requested_reviewer?.login;
    if (login == null || !targetLogins.has(login)) {
      continue;
    }
    const existing = latestByLogin.get(login);
    if (existing == null || isTimestampAfter(event.created_at, existing)) {
      latestByLogin.set(login, event.created_at);
    }
  }

  return latestByLogin;
}

function toPullReviewerMetadata(
  pullNumber: string,
  pull: z.infer<typeof pullSchema>,
): PullReviewerMetadata {
  return {
    number: pullNumber,
    authorLogin: pull.user.login,
    requestedUsers: pull.requested_reviewers.map((reviewer) => ({
      login: reviewer.login,
      avatarUrl: normalizeAvatarUrl(reviewer.avatar_url),
    })),
    requestedTeams: pull.requested_teams.map((team) => team.slug),
  };
}

export async function validateAccountToken(
  account: { token: string } | null,
): Promise<TokenValidationResult> {
  if (account == null) {
    return {
      ok: false,
      message: "No account provided — sign in with GitHub from the options page.",
    };
  }
  const rateLimitEndpoint: GitHubEndpointDescriptor = {
    name: "pulls-list",
    method: "GET",
    path: "/rate_limit",
  };
  const response = await fetch("https://api.github.com/rate_limit", {
    headers: createGitHubHeaders(account.token),
  });
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
  const response = await fetch(`https://api.github.com${listEndpoint.path}`, {
    headers: createGitHubHeaders(auth.githubToken),
  });

  if (!response.ok) {
    const error = await createGitHubApiError(response, listEndpoint);
    return {
      ok: false,
      authMode,
      outcome: classifyRepositoryValidationOutcome(error, auth),
      fullName,
      message: describeRepositoryValidationError(error, fullName, auth),
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

async function collectReviewsAcrossPages(params: {
  firstResponse: Response;
  endpoint: GitHubEndpointDescriptor;
  headers: Headers;
  signal?: AbortSignal;
}): Promise<z.infer<typeof reviewsSchema>> {
  const collected: z.infer<typeof reviewsSchema> = [];

  let response = params.firstResponse;
  while (true) {
    const parsed = reviewsSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new GitHubApiSchemaError(params.endpoint, parsed.error.issues);
    }
    collected.push(...parsed.data);

    const nextUrl = parseNextPageUrl(response.headers.get("Link"));
    if (nextUrl == null) {
      return collected;
    }

    response = await fetch(
      nextUrl,
      withOptionalSignal({ headers: params.headers }, params.signal),
    );

    const error = await createGitHubApiErrorFromResponse(
      response,
      params.endpoint,
    );
    if (error != null) {
      throw new GitHubPullRequestEndpointsError([error]);
    }
  }
}

async function collectReviewRequestEventsAcrossPages(params: {
  firstResponse: Response;
  endpoint: GitHubEndpointDescriptor;
  headers: Headers;
  signal?: AbortSignal;
}): Promise<z.infer<typeof reviewRequestEventsSchema>> {
  const collected: z.infer<typeof reviewRequestEventsSchema> = [];

  let response = params.firstResponse;
  let pageCount = 0;
  while (true) {
    const parsed = reviewRequestEventsSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new GitHubApiSchemaError(params.endpoint, parsed.error.issues);
    }
    collected.push(...parsed.data);
    pageCount += 1;

    if (pageCount >= MAX_REVIEW_REQUEST_EVENT_PAGES) {
      return collected;
    }

    const nextUrl = parseNextPageUrl(response.headers.get("Link"));
    if (nextUrl == null || !isGitHubApiUrl(nextUrl)) {
      return collected;
    }

    response = await fetch(
      nextUrl,
      withOptionalSignal({ headers: params.headers }, params.signal),
    );

    const error = await createGitHubApiErrorFromResponse(
      response,
      params.endpoint,
    );
    if (error != null) {
      throw new GitHubPullRequestEndpointsError([error]);
    }
  }
}

async function collectPullMetadataAcrossPages(params: {
  firstResponse: Response;
  endpoint: GitHubEndpointDescriptor;
  headers: Headers;
  targetPullNumbers: string[];
  signal?: AbortSignal;
}): Promise<z.infer<typeof pullReviewerMetadataListSchema>> {
  const collected: z.infer<typeof pullReviewerMetadataListSchema> = [];
  const targets = new Set(params.targetPullNumbers);
  const expectedPathname = params.endpoint.path.split("?")[0];

  let response = params.firstResponse;
  let pageCount = 0;
  while (true) {
    const parsed = pullReviewerMetadataListSchema.safeParse(
      await response.json(),
    );
    if (!parsed.success) {
      throw new GitHubApiSchemaError(params.endpoint, parsed.error.issues);
    }
    collected.push(...parsed.data);
    pageCount += 1;

    if (
      targets.size === 0 ||
      hasAllTargetPulls(collected, targets) ||
      pageCount >= MAX_PULL_METADATA_BATCH_PAGES
    ) {
      return collected;
    }

    const nextUrl = parseNextPageUrl(
      response.headers.get("Link"),
      expectedPathname,
    );
    if (nextUrl == null) {
      return collected;
    }

    response = await fetch(
      nextUrl,
      withOptionalSignal({ headers: params.headers }, params.signal),
    );

    const error = await createGitHubApiErrorFromResponse(
      response,
      params.endpoint,
    );
    if (error != null) {
      throw error;
    }
  }
}

function hasAllTargetPulls(
  pulls: z.infer<typeof pullReviewerMetadataListSchema>,
  targets: Set<string>,
): boolean {
  const pullNumbers = new Set(pulls.map((pull) => String(pull.number)));
  for (const target of targets) {
    if (!pullNumbers.has(target)) {
      return false;
    }
  }
  return true;
}

function parseNextPageUrl(
  linkHeader: string | null,
  expectedPathname?: string,
): string | null {
  if (linkHeader == null) {
    return null;
  }

  for (const segment of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(segment.trim());
    if (match == null) {
      continue;
    }
    const rels = match[2].split(/\s+/);
    if (rels.includes("next")) {
      if (
        expectedPathname != null &&
        !isExpectedGitHubApiUrl(match[1], expectedPathname)
      ) {
        return null;
      }
      return match[1];
    }
  }

  return null;
}

function isExpectedGitHubApiUrl(url: string, expectedPathname: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "api.github.com" &&
      parsed.pathname === expectedPathname
    );
  } catch {
    return false;
  }
}

function isGitHubApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "api.github.com";
  } catch {
    return false;
  }
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

function isReviewRequestAfterReview(
  requestedAt: string | null,
  reviewedAt: string | null,
): boolean {
  // GitHub should provide submitted_at for non-PENDING reviews. If it is
  // absent, prefer the completed review state over showing a refresh badge.
  return isTimestampAfter(requestedAt, reviewedAt);
}

function isTimestampAfter(left: string | null, right: string | null): boolean {
  if (left == null || right == null) {
    return false;
  }

  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return false;
  }

  return leftTime > rightTime;
}

function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }

  return error instanceof Error && error.name === "AbortError";
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

function buildIssueEventsEndpoint(
  owner: string,
  repo: string,
  pullNumber: string,
): GitHubEndpointDescriptor {
  return {
    name: "issue-events",
    method: "GET",
    path: `/repos/${owner}/${repo}/issues/${pullNumber}/events`,
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

function buildPullsMetadataEndpoint(
  owner: string,
  repo: string,
): GitHubEndpointDescriptor {
  return {
    name: "pulls-list",
    method: "GET",
    path: `/repos/${owner}/${repo}/pulls?per_page=100&state=all`,
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

// Matches GitHub's documented rate-limit error messages only:
// - primary:   "API rate limit exceeded for …"
// - secondary: "You have exceeded a secondary rate limit …"
// Word boundaries prevent false positives like "no rate limit applied".
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
