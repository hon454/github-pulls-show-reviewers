import type {
  CompletedReview,
  PullReviewerSummary,
  ReviewState,
  ReviewerUser,
} from "../../github/api";
import type { PullListRoute } from "../../github/routes";

export type ReviewerEntry =
  | {
      kind: "user";
      login: string;
      avatarUrl: string | null;
      state: ReviewState | null;
      isRequested: boolean;
      href: string;
    }
  | {
      kind: "team";
      slug: string;
      href: string;
    };

export function buildReviewers(
  route: PullListRoute,
  summary: PullReviewerSummary,
): ReviewerEntry[] {
  const reviewedByLogin = new Map<string, CompletedReview>();
  for (const review of summary.completedReviews) {
    reviewedByLogin.set(review.login, review);
  }

  const requestedByLogin = new Map<string, ReviewerUser>();
  for (const user of summary.requestedUsers) {
    requestedByLogin.set(user.login, user);
  }

  const allLogins = new Set<string>([
    ...reviewedByLogin.keys(),
    ...requestedByLogin.keys(),
  ]);

  const userEntries: Extract<ReviewerEntry, { kind: "user" }>[] = [];
  for (const login of allLogins) {
    const reviewed = reviewedByLogin.get(login);
    const requested = requestedByLogin.get(login);
    const isRequested = requested != null;
    const state = reviewed?.state ?? null;
    const avatarUrl = reviewed?.avatarUrl ?? requested?.avatarUrl ?? null;
    userEntries.push({
      kind: "user",
      login,
      avatarUrl,
      state,
      isRequested,
      href: buildUserHref(route, login, state),
    });
  }

  userEntries.sort((left, right) => {
    const rankDelta = rankUser(left) - rankUser(right);
    if (rankDelta !== 0) return rankDelta;
    return left.login.localeCompare(right.login);
  });

  const teamEntries: Extract<ReviewerEntry, { kind: "team" }>[] = [
    ...summary.requestedTeams,
  ]
    .sort((left, right) => left.localeCompare(right))
    .map((slug) => ({
      kind: "team" as const,
      slug,
      href: buildTeamHref(route, slug),
    }));

  return [...userEntries, ...teamEntries];
}

function rankUser(entry: Extract<ReviewerEntry, { kind: "user" }>): number {
  if (!entry.isRequested) {
    return entry.state === "CHANGES_REQUESTED" ? 0 : 1;
  }
  if (entry.state === "COMMENTED") return 2;
  if (entry.state === "DISMISSED") return 3;
  if (entry.state != null) return 3.5;
  return 4;
}

function buildUserHref(
  route: PullListRoute,
  login: string,
  state: ReviewState | null,
): string {
  const qualifier = state != null
    ? `reviewed-by:${login}`
    : `review-requested:${login}`;
  const query = `is:pr ${qualifier}`;
  return `https://github.com/${route.owner}/${route.repo}/pulls?q=${encodeURIComponent(query)}`;
}

function buildTeamHref(route: PullListRoute, slug: string): string {
  const query = `is:pr team-review-requested:${route.owner}/${slug}`;
  return `https://github.com/${route.owner}/${route.repo}/pulls?q=${encodeURIComponent(query)}`;
}
