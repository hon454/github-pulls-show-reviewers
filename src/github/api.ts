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

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly details?: string,
  ) {
    super(`GitHub API request failed with status ${status}.`);
    this.name = "GitHubApiError";
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
  if (error instanceof GitHubApiError) {
    if (error.status === 401) {
      return settings.githubToken
        ? "Saved token is invalid or expired."
        : "Private repository or restricted data. Add a fine-grained token in settings.";
    }

    if (error.status === 403) {
      return settings.githubToken
        ? "GitHub denied access. Check pull request permissions or API limits."
        : "GitHub denied unauthenticated access. Add a token for private repositories or higher rate limits.";
    }

    if (error.status === 404) {
      return settings.githubToken
        ? "Repository or pull request is not accessible with the current token."
        : "Pull request data is not accessible. A token may be required for private repositories.";
    }

    return error.details ?? error.message;
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
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });

  if (input.settings.githubToken) {
    headers.set("Authorization", `Bearer ${input.settings.githubToken}`);
  }

  const pullUrl = `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}`;
  const reviewUrl = `${pullUrl}/reviews`;

  const [pullResponse, reviewsResponse] = await Promise.all([
    fetch(pullUrl, { headers, signal: input.signal }),
    fetch(reviewUrl, { headers, signal: input.signal }),
  ]);

  if (!pullResponse.ok) {
    throw await createGitHubApiError(pullResponse);
  }

  if (!reviewsResponse.ok) {
    throw await createGitHubApiError(reviewsResponse);
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

    if (normalizedState == null || reviewer == null || reviewer === pull.user.login) {
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

export async function validateGitHubToken(token: string): Promise<TokenValidationResult> {
  const response = await fetch("https://api.github.com/rate_limit", {
    headers: new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
    }),
  });

  if (!response.ok) {
    const error = await createGitHubApiError(response);
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

async function createGitHubApiError(response: Response): Promise<GitHubApiError> {
  const payload = errorResponseSchema.safeParse(await response.json().catch(() => null));
  return new GitHubApiError(
    response.status,
    payload.success ? payload.data.message : undefined,
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
