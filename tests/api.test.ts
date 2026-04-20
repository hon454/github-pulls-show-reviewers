import { describe, expect, it } from "vitest";

import { GitHubApiError, describeGitHubApiError } from "../src/github/api";

describe("describeGitHubApiError", () => {
  it("returns a token-specific 401 message", () => {
    const message = describeGitHubApiError(new GitHubApiError(401), {
      githubToken: "github_pat_example",
    });

    expect(message).toBe("Saved token is invalid or expired.");
  });

  it("returns a private-repository hint when unauthenticated", () => {
    const message = describeGitHubApiError(new GitHubApiError(401), {
      githubToken: null,
    });

    expect(message).toContain("Private repository");
  });
});
