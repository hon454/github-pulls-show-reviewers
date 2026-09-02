import {
  normalizeAvatarUrl,
  pullReviewerMetadataListSchema,
  pullSchema,
  reviewRequestEventsSchema,
  reviewsSchema,
  type GitHubPull,
  type GitHubPullReviewerMetadata,
  type GitHubReview,
  type GitHubReviewRequestEvent,
} from "./schemas";
import {
  collectGitHubApiPages,
  createGitHubApiErrorFromResponse,
  createGitHubHeaders,
  fetchGitHubApiResponse,
} from "./request";
import {
  GitHubApiSchemaError,
  GitHubPullRequestEndpointsError,
  type CompletedReview,
  type GitHubApiError,
  type GitHubEndpointDescriptor,
  type PullReviewerMetadata,
  type PullReviewerSummary,
  type ReviewerUser,
  type ReviewState,
} from "./types";

export const PULL_METADATA_BATCH_PAGE_BUDGET = 3;
export const REVIEW_REQUEST_EVENT_PAGE_BUDGET = 2;

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
    const reviewsFirstResponse = await fetchGitHubApiResponse(
      reviewsFirstPageUrl,
      headers,
      input.signal,
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
    fetchGitHubApiResponse(pullUrl, headers, input.signal),
    fetchGitHubApiResponse(reviewsFirstPageUrl, headers, input.signal),
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

  const pullMetadata = toPullReviewerMetadata(
    input.pullNumber,
    pullParsed.data,
  );
  const latestReviewEvidence = collectLatestReviewEvidence(
    pullMetadata,
    reviews,
  );
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
  const response = await fetchGitHubApiResponse(
    `https://api.github.com${endpoint.path}`,
    headers,
    input.signal,
  );

  const failure = await createGitHubApiErrorFromResponse(response, endpoint);
  if (failure != null) {
    throw failure;
  }

  const targets = new Set(input.targetPullNumbers ?? []);
  const pulls = await collectGitHubApiPages<GitHubPullReviewerMetadata>({
    firstResponse: response,
    endpoint,
    headers,
    schema: pullReviewerMetadataListSchema,
    pageBudget: PULL_METADATA_BATCH_PAGE_BUDGET,
    hasEnough: (collected) =>
      targets.size === 0 || hasAllTargetPulls(collected, targets),
    ...(input.signal == null ? {} : { signal: input.signal }),
  });

  return pulls.map((pull) => toPullReviewerMetadata(String(pull.number), pull));
}

function buildPullReviewerSummary(
  pullMetadata: PullReviewerMetadata,
  latestReviewEvidence: LatestReviewEvidence,
  latestReviewRequestByLogin: Map<string, string> | null = null,
): PullReviewerSummary {
  const { latestNonCommentByUser, latestCommentByUser } = latestReviewEvidence;

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
  reviews: GitHubReview[],
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
    const firstResponse = await fetchGitHubApiResponse(
      firstPageUrl,
      params.headers,
      params.signal,
    );

    const failure = await createGitHubApiErrorFromResponse(
      firstResponse,
      endpoint,
    );
    if (failure != null) {
      throw new GitHubPullRequestEndpointsError([failure]);
    }

    const events = await collectGitHubApiPages<GitHubReviewRequestEvent>({
      firstResponse,
      endpoint,
      headers: params.headers,
      schema: reviewRequestEventsSchema,
      pageBudget: REVIEW_REQUEST_EVENT_PAGE_BUDGET,
      mapNextPageError: (error) => new GitHubPullRequestEndpointsError([error]),
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

function collectReviewsAcrossPages(params: {
  firstResponse: Response;
  endpoint: GitHubEndpointDescriptor;
  headers: Headers;
  signal?: AbortSignal;
}): Promise<GitHubReview[]> {
  return collectGitHubApiPages<GitHubReview>({
    ...params,
    schema: reviewsSchema,
    mapNextPageError: (error) => new GitHubPullRequestEndpointsError([error]),
  });
}

function filterStaleRequestedUsers(
  requestedUsers: ReviewerUser[],
  latestNonCommentByUser: Map<string, LatestNonCommentReview>,
  latestReviewRequestByLogin: Map<string, string> | null,
): ReviewerUser[] {
  if (latestReviewRequestByLogin == null) {
    return requestedUsers;
  }

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
  events: GitHubReviewRequestEvent[],
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
  pull: GitHubPull,
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

function hasAllTargetPulls(
  pulls: GitHubPullReviewerMetadata[],
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
