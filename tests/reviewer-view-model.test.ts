import { describe, expect, it } from "vitest";

import { buildReviewerSections } from "../src/features/reviewers/view-model";

describe("buildReviewerSections", () => {
  const route = {
    owner: "hon454",
    repo: "github-pulls-show-reviewers",
  };

  it("builds requested and reviewed sections with repo-scoped links", () => {
    const sections = buildReviewerSections(route, {
      status: "ok",
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

  it("omits both sections when no requested reviewers or completed reviews exist", () => {
    const sections = buildReviewerSections(route, {
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [],
    });

    expect(sections).toEqual([]);
  });

  it("renders only the reviewed section when there are no requested reviewers", () => {
    const sections = buildReviewerSections(route, {
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [{ login: "bob", state: "APPROVED" }],
    });

    expect(sections.map((section) => section.label)).toEqual(["Reviewed"]);
    expect(sections[0]?.chips[0]?.label).toContain("bob");
  });
});
