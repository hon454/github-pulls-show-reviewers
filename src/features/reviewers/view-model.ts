import type { CompletedReview, PullReviewerSummary, ReviewState } from "../../github/api";
import type { PullListRoute } from "../../github/routes";

export type ReviewerChipTone =
  | "requested"
  | "team"
  | "approved"
  | "changes-requested"
  | "commented"
  | "dismissed";

export type ReviewerChip = {
  label: string;
  href: string;
  tone: ReviewerChipTone;
  title?: string;
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
  const reviewedChips = [...summary.completedReviews]
    .sort((left, right) => compareReviewState(left, right))
    .map((review) => buildReviewedChip(route, review));

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

function buildReviewedChip(route: PullListRoute, review: CompletedReview): ReviewerChip {
  const tone = mapReviewStateToTone(review.state);
  const suffix = formatReviewState(review.state);

  return {
    label: `${review.login} · ${suffix}`,
    title: `${review.login}: ${suffix}`,
    tone,
    href: buildPullSearchUrl(route, review.login, tone, false),
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

  if (
    tone === "approved" ||
    tone === "changes-requested" ||
    tone === "commented" ||
    tone === "dismissed"
  ) {
    query += ` reviewed-by:${normalizedReviewer}`;
  } else if (isTeam) {
    query += ` team-review-requested:${route.owner}/${normalizedReviewer}`;
  } else {
    query += ` review-requested:${normalizedReviewer}`;
  }

  return `https://github.com/${route.owner}/${route.repo}/pulls?q=${encodeURIComponent(query)}`;
}

function mapReviewStateToTone(state: ReviewState): ReviewerChipTone {
  if (state === "APPROVED") {
    return "approved";
  }

  if (state === "CHANGES_REQUESTED") {
    return "changes-requested";
  }

  if (state === "DISMISSED") {
    return "dismissed";
  }

  return "commented";
}

function formatReviewState(state: ReviewState): string {
  if (state === "CHANGES_REQUESTED") {
    return "changes requested";
  }

  return state.toLowerCase();
}

function compareReviewState(left: CompletedReview, right: CompletedReview): number {
  const priority = {
    CHANGES_REQUESTED: 0,
    APPROVED: 1,
    COMMENTED: 2,
    DISMISSED: 3,
  } as const;

  return (
    priority[left.state] - priority[right.state] ||
    left.login.localeCompare(right.login)
  );
}
