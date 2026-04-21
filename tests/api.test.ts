import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitHubApiError,
  fetchPullReviewerSummary,
  describeGitHubApiError,
  parseRepositoryReference,
  validateGitHubRepositoryAccess,
} from "../src/github/api";

type RepositoryValidationMatrixCase = {
  name: string;
  token: string | null;
  repository: string;
  responses: Array<{
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  }>;
  expected: {
    ok: boolean;
    authMode: "token" | "no-token";
    outcome: string;
    pullNumber: string;
    messageIncludes: string[];
    authorizationHeader?: null;
    authorizationHeaderPrefix?: string;
  };
};

const repositoryValidationMatrix = JSON.parse(
  readFileSync(
    new URL("./fixtures/repository-validation-matrix.json", import.meta.url),
    "utf8",
  ),
) as RepositoryValidationMatrixCase[];

afterEach(() => {
  vi.restoreAllMocks();
});

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

    expect(message).toContain("private");
  });

  it("includes endpoint-specific rate-limit context for unauthenticated requests", () => {
    const message = describeGitHubApiError(
      new GitHubApiError(
        403,
        "API rate limit exceeded",
        {
          name: "reviews",
          method: "GET",
          path: "/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews",
        },
        {
          limit: 60,
          remaining: 0,
          resource: "core",
          resetAt: null,
        },
      ),
      {
        githubToken: null,
      },
    );

    expect(message).toContain(
      "/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews",
    );
    expect(message).toContain("unauthenticated rate limit");
  });

  it("parses repository references", () => {
    expect(
      parseRepositoryReference(
        "https://github.com/hon454/github-pulls-show-reviewers",
      ),
    ).toEqual({
      owner: "hon454",
      repo: "github-pulls-show-reviewers",
    });
  });
});

describe("fetchPullReviewerSummary", () => {
  it("supports public repository reads without sending an authorization header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { login: "hon454" },
            requested_reviewers: [{ login: "alice" }],
            requested_teams: [{ slug: "platform" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              state: "APPROVED",
              submitted_at: "2026-04-20T12:00:00Z",
              user: { login: "bob" },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const summary = await fetchPullReviewerSummary({
      owner: "hon454",
      repo: "github-pulls-show-reviewers",
      pullNumber: "42",
      githubToken: null,
    });

    expect(summary).toEqual({
      status: "ok",
      requestedUsers: ["alice"],
      requestedTeams: ["platform"],
      completedReviews: [{ login: "bob", state: "APPROVED" }],
    });

    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(firstHeaders).toBeInstanceOf(Headers);
    expect((firstHeaders as Headers).get("Authorization")).toBeNull();
  });

  it("returns status 'ok' on a successful fetch", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { login: "hon454" },
            requested_reviewers: [],
            requested_teams: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const summary = await fetchPullReviewerSummary({
      owner: "hon454",
      repo: "github-pulls-show-reviewers",
      pullNumber: "1",
      githubToken: null,
    });

    expect(summary.status).toBe("ok");
  });

  it("reports the exact reviews endpoint when review history access is denied", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { login: "hon454" },
            requested_reviewers: [],
            requested_teams: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "Resource not accessible by integration",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      );

    try {
      await fetchPullReviewerSummary({
        owner: "hon454",
        repo: "github-pulls-show-reviewers",
        pullNumber: "42",
        githubToken: "github_pat_example",
      });
      throw new Error("Expected fetchPullReviewerSummary to reject.");
    } catch (error) {
      expect(error).toMatchObject({
        name: "GitHubPullRequestEndpointsError",
      });

      const message = describeGitHubApiError(error, {
        githubToken: "github_pat_example",
      });
      expect(message).toContain(
        "/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews",
      );
      expect(message).toContain("'repo' scope");
      expect(message).toContain("public_repo");
      expect(message).toContain("SSO");
    }
  });
});

describe("validateGitHubRepositoryAccess", () => {
  for (const fixtureCase of repositoryValidationMatrix) {
    it(`matches the documented matrix for ${fixtureCase.name}`, async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");

      for (const responseConfig of fixtureCase.responses) {
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify(responseConfig.body), {
            status: responseConfig.status,
            headers: {
              "Content-Type": "application/json",
              ...responseConfig.headers,
            },
          }),
        );
      }

      const result = await validateGitHubRepositoryAccess(
        fixtureCase.token,
        fixtureCase.repository,
      );

      expect(result.ok).toBe(fixtureCase.expected.ok);
      expect(result.authMode).toBe(fixtureCase.expected.authMode);
      expect(result.outcome).toBe(fixtureCase.expected.outcome);
      expect(result.pullNumber).toBe(fixtureCase.expected.pullNumber);

      for (const fragment of fixtureCase.expected.messageIncludes) {
        expect(result.message).toContain(fragment);
      }

      const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers;
      expect(firstHeaders).toBeInstanceOf(Headers);

      const authorizationHeader = (firstHeaders as Headers).get(
        "Authorization",
      );
      if ("authorizationHeader" in fixtureCase.expected) {
        expect(authorizationHeader).toBe(
          fixtureCase.expected.authorizationHeader,
        );
      }

      if (fixtureCase.expected.authorizationHeaderPrefix) {
        expect(authorizationHeader).toContain(
          fixtureCase.expected.authorizationHeaderPrefix,
        );
      }
    });
  }
});
