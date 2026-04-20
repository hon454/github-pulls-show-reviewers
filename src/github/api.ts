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
    user: z
      .object({
        login: z.string(),
      })
      .nullable(),
  }),
);

export type PullReviewerSummary = {
  requestedUsers: string[];
  requestedTeams: string[];
  completedReviewers: string[];
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
        ? "GitHub rejected the saved token. Check the token value and permissions."
        : "This repository may require authentication. Add a fine-grained token in settings.";
    }

    if (error.status === 403) {
      return "GitHub rate limited or denied this request. Check token permissions and API limits.";
    }

    if (error.status === 404) {
      return settings.githubToken
        ? "GitHub could not find this pull request with the current token."
        : "GitHub could not find this pull request. A token may be required for private repositories.";
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
  const completedReviewers = Array.from(
    new Set(
      reviews
        .filter((review) => review.state.toUpperCase() !== "PENDING")
        .map((review) => review.user?.login)
        .filter(
          (reviewer): reviewer is string =>
            reviewer != null && reviewer !== pull.user.login,
        ),
    ),
  );

  return {
    requestedUsers: pull.requested_reviewers.map((reviewer) => reviewer.login),
    requestedTeams: pull.requested_teams.map((team) => team.slug),
    completedReviewers,
  };
}

async function createGitHubApiError(response: Response): Promise<GitHubApiError> {
  const payload = errorResponseSchema.safeParse(await response.json().catch(() => null));
  return new GitHubApiError(
    response.status,
    payload.success ? payload.data.message : undefined,
  );
}
