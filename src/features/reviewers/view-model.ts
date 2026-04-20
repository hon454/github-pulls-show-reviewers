import type { PullReviewerSummary } from "../../github/api";
import type { PullListRoute } from "../../github/routes";

export type ReviewerChipTone = "requested" | "reviewed" | "team";

export type ReviewerChip = {
  label: string;
  href: string;
  tone: ReviewerChipTone;
};

export type ReviewerSection = {
  label: string;
  emptyLabel: string;
  chips: ReviewerChip[];
};

export function buildReviewerSections(
  route: PullListRoute,
  summary: PullReviewerSummary,
): ReviewerSection[] {
  const requestedUserChips = summary.requestedUsers.map((reviewer) =>
    buildChip(route, reviewer, "requested"),
  );
  const requestedTeamChips = summary.requestedTeams.map((team) =>
    buildChip(route, `@${team}`, "team"),
  );
  const reviewedChips = summary.completedReviewers.map((reviewer) =>
    buildChip(route, reviewer, "reviewed"),
  );

  return [
    {
      label: "Requested",
      emptyLabel: "No requested reviewers",
      chips: [...requestedUserChips, ...requestedTeamChips],
    },
    {
      label: "Reviewed",
      emptyLabel: "No completed reviews",
      chips: reviewedChips,
    },
  ];
}

function buildChip(
  route: PullListRoute,
  rawReviewer: string,
  tone: ReviewerChipTone,
): ReviewerChip {
  const isTeam = rawReviewer.startsWith("@");
  const label = rawReviewer;

  return {
    label,
    tone,
    href: buildPullSearchUrl(route, rawReviewer, tone, isTeam),
  };
}

function buildPullSearchUrl(
  route: PullListRoute,
  reviewer: string,
  tone: ReviewerChipTone,
  isTeam: boolean,
): string {
  const normalizedReviewer = isTeam ? reviewer.slice(1) : reviewer;
  let query = "is:pr";

  if (tone === "reviewed") {
    query += ` reviewed-by:${normalizedReviewer}`;
  } else if (isTeam) {
    query += ` team-review-requested:${route.owner}/${normalizedReviewer}`;
  } else {
    query += ` review-requested:${normalizedReviewer}`;
  }

  return `https://github.com/${route.owner}/${route.repo}/pulls?q=${encodeURIComponent(query)}`;
}
