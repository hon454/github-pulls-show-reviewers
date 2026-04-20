import { z } from "zod";

import type { ExtensionSettings } from "~/storage/settings";

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
    throw new Error(`GitHub pull request API failed with status ${pullResponse.status}.`);
  }

  if (!reviewsResponse.ok) {
    throw new Error(`GitHub reviews API failed with status ${reviewsResponse.status}.`);
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
