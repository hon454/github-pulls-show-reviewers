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
  collectGitHubApiPagesDetailed,
  createGitHubApiErrorFromResponse,
  createGitHubHeaders,
  fetchGitHubApiResponse,
} from "./request";
import {
  GitHubApiSchemaError,
  GitHubApiError,
  GitHubApiTransportError,
  GitHubPullRequestEndpointsError,
  type CompletedReview,
  type GitHubEndpointDescriptor,
  type PullReviewerMetadata,
  type PullReviewerSummary,
  type ReviewRequestEvidence,
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

type ReviewRequestEventLookup = {
  status: "complete" | "truncated" | "unavailable";
  latestValidRequestByLogin: Map<string, string>;
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

  // Preserve failures from both endpoints, including transport/schema failures.
  // Promise.all's first rejection must not hide a sibling's 401/rate limit.
  const results = await Promise.allSettled([
    readEndpoint(pullUrl, pullEndpoint, async (response) => {
      const parsed = pullSchema.safeParse(await response.json());
      if (!parsed.success) throw new GitHubApiSchemaError(pullEndpoint);
      return parsed.data;
    }),
    readEndpoint(reviewsFirstPageUrl, reviewsEndpoint, (response) =>
      collectReviewsAcrossPages({
        firstResponse: response,
        endpoint: reviewsEndpoint,
        headers,
        ...(input.signal == null ? {} : { signal: input.signal }),
      }),
    ),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (
    failures.length === 1 &&
    !(failures[0] instanceof GitHubApiError) &&
    !(failures[0] instanceof GitHubPullRequestEndpointsError)
  )
    throw failures[0];
  if (failures.length > 0) throw new GitHubPullRequestEndpointsError(failures);
  if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled")
    throw new Error("missing_endpoint_result");
  const pull = results[0].value;
  const reviews = results[1].value;

  async function readEndpoint<T>(
    url: string,
    endpoint: GitHubEndpointDescriptor,
    parse: (response: Response) => Promise<T>,
  ): Promise<T> {
    try {
      const response = await fetchGitHubApiResponse(url, headers, input.signal);
      const error = await createGitHubApiErrorFromResponse(response, endpoint);
      if (error) throw error;
      return await parse(response);
    } catch (error) {
      if (
        error instanceof GitHubApiError ||
        error instanceof GitHubApiSchemaError ||
        error instanceof GitHubPullRequestEndpointsError
      )
        throw error;
      throw new GitHubApiTransportError(
        isAbortError(error)
          ? "cancellation"
          : error instanceof SyntaxError
            ? "schema"
            : error instanceof TypeError
              ? "network"
              : "unknown",
        endpoint,
      );
    }
  }

  const pullMetadata = toPullReviewerMetadata(input.pullNumber, pull);
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
  reviewRequestLookup: ReviewRequestEventLookup | null = null,
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

  const requested = resolveRequestedUsers(
    pullMetadata.requestedUsers,
    latestNonCommentByUser,
    reviewRequestLookup,
  );

  return {
    status: "ok" as const,
    requestedUsers: requested.users,
    requestedTeams: pullMetadata.requestedTeams,
    completedReviews,
    ...(requested.evidence.length === 0
      ? {}
      : { reviewRequestEvidence: requested.evidence }),
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
}): Promise<ReviewRequestEventLookup | null> {
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

    const result =
      await collectGitHubApiPagesDetailed<GitHubReviewRequestEvent>({
        firstResponse,
        endpoint,
        headers: params.headers,
        schema: reviewRequestEventsSchema,
        pageBudget: REVIEW_REQUEST_EVENT_PAGE_BUDGET,
        mapNextPageError: (error) =>
          new GitHubPullRequestEndpointsError([error]),
        ...(params.signal == null ? {} : { signal: params.signal }),
      });

    if (result.status === "unavailable" && isAbortError(result.error)) {
      throw result.error;
    }
    if (
      result.status === "unavailable" &&
      result.error instanceof GitHubApiSchemaError
    ) {
      console.warn(result.error.message, result.error.issues);
    }
    return {
      status: result.status,
      latestValidRequestByLogin: selectLatestReviewRequestByLogin(
        result.items,
        new Set(ambiguousLogins),
      ),
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof GitHubApiSchemaError) {
      console.warn(error.message, error.issues);
    }
    return {
      status: "unavailable",
      latestValidRequestByLogin: new Map(),
    };
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

function resolveRequestedUsers(
  requestedUsers: ReviewerUser[],
  latestNonCommentByUser: Map<string, LatestNonCommentReview>,
  lookup: ReviewRequestEventLookup | null,
): { users: ReviewerUser[]; evidence: ReviewRequestEvidence[] } {
  const users: ReviewerUser[] = [];
  const evidence: ReviewRequestEvidence[] = [];

  for (const user of requestedUsers) {
    const latestReview = latestNonCommentByUser.get(user.login);
    if (latestReview == null) {
      users.push(user);
      continue;
    }

    const latestRequest =
      lookup?.latestValidRequestByLogin.get(user.login) ?? null;
    if (isReviewRequestAfterReview(latestRequest, latestReview.submittedAt)) {
      users.push(user);
      evidence.push({ login: user.login, status: "confirmed" });
      continue;
    }

    if (
      lookup?.status === "complete" &&
      isValidTimestamp(latestRequest) &&
      isValidTimestamp(latestReview.submittedAt)
    ) {
      continue;
    }

    users.push(user);
    evidence.push({ login: user.login, status: "unverified" });
  }

  return { users, evidence };
}

function isValidTimestamp(value: string | null): value is string {
  return parseValidTimestamp(value) != null;
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
    if (
      login == null ||
      !targetLogins.has(login) ||
      !isValidTimestamp(event.created_at)
    ) {
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
  const leftTime = parseValidTimestamp(left);
  const rightTime = parseValidTimestamp(right);
  if (leftTime == null || rightTime == null) return false;

  return leftTime > rightTime;
}

function parseValidTimestamp(value: string | null): number | null {
  if (value == null) return null;

  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match == null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] == null ? 0 : Number(match[8]);
  const offsetMinute = match[9] == null ? 0 : Number(match[9]);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    daysInMonth == null ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
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
