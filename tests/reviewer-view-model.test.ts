import { describe, expect, it } from "vitest";

import { buildReviewerSections } from "../src/features/reviewers/view-model";

describe("buildReviewerSections", () => {
  const route = {
    owner: "hon454",
    repo: "github-pulls-show-reviewers",
  };

  it("builds requested and reviewed sections with repo-scoped links", () => {
    const sections = buildReviewerSections(route, {
      requestedUsers: ["alice"],
      requestedTeams: ["platform"],
      completedReviews: [{ login: "bob", state: "APPROVED" }],
    });

    expect(sections[0]?.chips.map((chip) => chip.label)).toEqual(["alice", "@platform"]);
    expect(sections[0]?.chips[0]?.href).toContain("review-requested%3Aalice");
    expect(sections[0]?.chips[1]?.href).toContain(
      "team-review-requested%3Ahon454%2Fplatform",
    );
    expect(sections[1]?.chips[0]?.label).toContain("approved");
    expect(sections[1]?.chips[0]?.href).toContain("reviewed-by%3Abob");
  });

  it("keeps empty states explicit", () => {
    const sections = buildReviewerSections(route, {
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [],
    });

    expect(sections[0]?.emptyLabel).toBe("No requested reviewers");
    expect(sections[1]?.emptyLabel).toBe("No completed reviews");
  });
});
