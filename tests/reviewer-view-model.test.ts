import { describe, expect, it } from "vitest";

import { buildReviewers } from "../src/features/reviewers/view-model";
import type { PullReviewerSummary } from "../src/github/api";

const route = { owner: "hon454", repo: "github-pulls-show-reviewers" };

function summary(partial: Partial<PullReviewerSummary>): PullReviewerSummary {
  return {
    status: "ok",
    requestedUsers: [],
    requestedTeams: [],
    completedReviews: [],
    ...partial,
  };
}

describe("buildReviewers", () => {
  it("returns an empty list when there are no reviewers or teams", () => {
    expect(buildReviewers(route, summary({}))).toEqual([]);
  });

  it("emits a single entry per login with state and isRequested combined", () => {
    const entries = buildReviewers(
      route,
      summary({
        requestedUsers: [
          { login: "alice", avatarUrl: null },
          { login: "bob", avatarUrl: null },
        ],
        completedReviews: [
          {
            login: "bob",
            avatarUrl: "https://example/b.png",
            state: "COMMENTED",
          },
        ],
      }),
    );

    const logins = entries
      .filter((entry) => entry.kind === "user")
      .map((entry) => (entry.kind === "user" ? entry.login : ""));
    expect(logins).toEqual(["bob", "alice"]);

    const bob = entries.find(
      (entry) => entry.kind === "user" && entry.login === "bob",
    );
    expect(bob).toMatchObject({
      kind: "user",
      login: "bob",
      state: "COMMENTED",
      isRequested: true,
      avatarUrl: "https://example/b.png",
    });
  });

  it("dedups DISMISSED reviewer who is still in requested_reviewers", () => {
    const entries = buildReviewers(
      route,
      summary({
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        completedReviews: [
          { login: "alice", avatarUrl: null, state: "DISMISSED" },
        ],
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "user",
      state: "DISMISSED",
      isRequested: true,
    });
  });

  it("marks APPROVED reviewers as isRequested: false when GitHub removed them", () => {
    const entries = buildReviewers(
      route,
      summary({
        requestedUsers: [],
        completedReviews: [
          { login: "alice", avatarUrl: null, state: "APPROVED" },
        ],
      }),
    );

    expect(entries[0]).toMatchObject({
      kind: "user",
      state: "APPROVED",
      isRequested: false,
    });
  });

  it("handles the approved-and-still-requested race (isRequested wins for border, state kept)", () => {
    const entries = buildReviewers(
      route,
      summary({
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        completedReviews: [
          { login: "alice", avatarUrl: null, state: "APPROVED" },
        ],
      }),
    );
    expect(entries[0]).toMatchObject({
      kind: "user",
      state: "APPROVED",
      isRequested: true,
    });
  });

  it("sorts users across all four buckets with alphabetical tiebreak", () => {
    const entries = buildReviewers(
      route,
      summary({
        requestedUsers: [
          { login: "zed", avatarUrl: null },
          { login: "eve", avatarUrl: null },
          { login: "cal", avatarUrl: null },
          { login: "mia", avatarUrl: null },
        ],
        completedReviews: [
          { login: "zed", avatarUrl: null, state: "COMMENTED" },
          { login: "mia", avatarUrl: null, state: "DISMISSED" },
          { login: "ben", avatarUrl: null, state: "APPROVED" },
          { login: "amy", avatarUrl: null, state: "CHANGES_REQUESTED" },
        ],
      }),
    );

    expect(
      entries
        .filter((entry) => entry.kind === "user")
        .map((entry) => (entry.kind === "user" ? entry.login : "")),
    ).toEqual([
      "amy", // resolved CHANGES_REQUESTED
      "ben", // resolved APPROVED
      "zed", // pending + COMMENTED
      "mia", // pending + DISMISSED
      "cal", // pending, no activity (alphabetical before eve)
      "eve",
    ]);
  });

  it("places teams after all user entries", () => {
    const entries = buildReviewers(
      route,
      summary({
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        requestedTeams: ["platform", "design"],
      }),
    );

    expect(entries.map((entry) => entry.kind)).toEqual([
      "user",
      "team",
      "team",
    ]);
    expect(
      entries
        .filter((entry) => entry.kind === "team")
        .map((entry) => (entry.kind === "team" ? entry.slug : "")),
    ).toEqual(["design", "platform"]);
  });

  it("builds user URLs with a compound review-requested OR reviewed-by qualifier", () => {
    const entries = buildReviewers(
      route,
      summary({
        requestedUsers: [{ login: "alice", avatarUrl: null }],
      }),
    );
    const user = entries[0];
    expect(user.kind).toBe("user");
    if (user.kind !== "user") return;
    const query = new URL(user.href).searchParams.get("q");
    expect(query).toContain("(review-requested:alice OR reviewed-by:alice)");
  });

  it("uses the same compound qualifier for completed reviewers", () => {
    const entries = buildReviewers(
      route,
      summary({
        completedReviews: [
          { login: "bob", avatarUrl: null, state: "APPROVED" },
        ],
      }),
    );
    const user = entries[0];
    expect(user.kind).toBe("user");
    if (user.kind !== "user") return;
    const query = new URL(user.href).searchParams.get("q");
    expect(query).toContain("(review-requested:bob OR reviewed-by:bob)");
  });

  it("uses the same compound qualifier when a reviewer is both requested and completed", () => {
    const entries = buildReviewers(
      route,
      summary({
        requestedUsers: [{ login: "carol", avatarUrl: null }],
        completedReviews: [
          { login: "carol", avatarUrl: null, state: "COMMENTED" },
        ],
      }),
    );
    const user = entries[0];
    expect(user.kind).toBe("user");
    if (user.kind !== "user") return;
    expect(user.isRequested).toBe(true);
    expect(user.state).toBe("COMMENTED");
    const query = new URL(user.href).searchParams.get("q");
    expect(query).toContain("(review-requested:carol OR reviewed-by:carol)");
  });

  it("scopes reviewer URLs to open pull requests by default", () => {
    const entries = buildReviewers(
      route,
      summary({
        completedReviews: [
          { login: "bob", avatarUrl: null, state: "APPROVED" },
        ],
        requestedTeams: ["platform"],
      }),
    );

    for (const entry of entries) {
      const query = new URL(entry.href).searchParams.get("q");
      expect(query).toContain("is:pr is:open");
    }
  });

  it("can build reviewer URLs without open-only scoping", () => {
    const entries = buildReviewers(
      route,
      summary({
        completedReviews: [
          { login: "bob", avatarUrl: null, state: "APPROVED" },
        ],
        requestedTeams: ["platform"],
      }),
      { openPullsOnly: false },
    );

    for (const entry of entries) {
      const query = new URL(entry.href).searchParams.get("q");
      expect(query).not.toContain("is:open");
    }
  });

  it("builds team-review-requested URLs scoped to the route owner", () => {
    const entries = buildReviewers(
      route,
      summary({ requestedTeams: ["platform"] }),
    );
    const team = entries[0];
    expect(team.kind).toBe("team");
    if (team.kind !== "team") return;
    expect(team.href).toContain("team-review-requested%3Ahon454%2Fplatform");
  });

  it("prefers the avatarUrl from the latest review when a login appears in both sources", () => {
    const entries = buildReviewers(
      route,
      summary({
        requestedUsers: [
          { login: "alice", avatarUrl: "https://old.example/a.png" },
        ],
        completedReviews: [
          {
            login: "alice",
            avatarUrl: "https://new.example/a.png",
            state: "COMMENTED",
          },
        ],
      }),
    );
    const user = entries[0];
    if (user.kind !== "user") throw new Error("expected user entry");
    expect(user.avatarUrl).toBe("https://new.example/a.png");
  });
});
