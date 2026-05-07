import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitHubApiError,
  GitHubApiSchemaError,
  fetchPullReviewerSummary,
  fetchPullReviewerMetadataBatch,
  describeGitHubApiError,
  isRateLimitError,
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
      githubToken: "ghu_example",
    });

    expect(message).toBe("Sign in again — the account's access was rejected by GitHub.");
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

describe("isRateLimitError", () => {
  it("returns true for HTTP 429", () => {
    expect(isRateLimitError(new GitHubApiError(429))).toBe(true);
  });

  it("returns true when rateLimit.remaining is exhausted", () => {
    const error = new GitHubApiError(403, undefined, undefined, {
      limit: 60,
      remaining: 0,
      resource: "core",
      resetAt: null,
    });
    expect(isRateLimitError(error)).toBe(true);
  });

  it('matches GitHub primary rate-limit message ("API rate limit exceeded …")', () => {
    expect(
      isRateLimitError(
        new GitHubApiError(403, "API rate limit exceeded for 1.2.3.4"),
      ),
    ).toBe(true);
  });

  it('matches GitHub secondary rate-limit message ("… secondary rate limit …")', () => {
    expect(
      isRateLimitError(
        new GitHubApiError(
          403,
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
        ),
      ),
    ).toBe(true);
  });

  it('does not match unrelated details that incidentally contain "rate limit"', () => {
    expect(
      isRateLimitError(
        new GitHubApiError(403, "This endpoint has no rate limit applied"),
      ),
    ).toBe(false);
  });

  it("returns false when no rate-limit signal is present", () => {
    expect(
      isRateLimitError(
        new GitHubApiError(403, "Resource not accessible by integration"),
      ),
    ).toBe(false);
  });
});

describe("fetchPullReviewerSummary", () => {
  it("skips the pull endpoint when page-level pull metadata is already available", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              state: "APPROVED",
              submitted_at: "2026-04-20T12:00:00Z",
              user: { login: "bob" },
            },
            {
              state: "APPROVED",
              submitted_at: "2026-04-20T12:05:00Z",
              user: { login: "hon454" },
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
      pullMetadata: {
        number: "42",
        authorLogin: "hon454",
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        requestedTeams: ["platform"],
      },
    });

    expect(summary).toEqual({
      status: "ok",
      requestedUsers: [{ login: "alice", avatarUrl: null }],
      requestedTeams: ["platform"],
      completedReviews: [{ login: "bob", avatarUrl: null, state: "APPROVED" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews?per_page=100",
    );
  });

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
      requestedUsers: [{ login: "alice", avatarUrl: null }],
      requestedTeams: ["platform"],
      completedReviews: [{ login: "bob", avatarUrl: null, state: "APPROVED" }],
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

  it("returns avatarUrl for requested reviewers and completed reviews", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { login: "hon454" },
            requested_reviewers: [
              { login: "alice", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" },
            ],
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
              user: {
                login: "bob",
                avatar_url: "https://avatars.githubusercontent.com/u/2?v=4",
              },
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

    expect(summary.requestedUsers).toEqual([
      { login: "alice", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
    ]);
    expect(summary.completedReviews).toEqual([
      {
        login: "bob",
        avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
        state: "APPROVED",
      },
    ]);
  });

  it("coerces missing, null, empty, and invalid avatar_url values to null without failing the payload", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { login: "hon454" },
            requested_reviewers: [
              { login: "alice" }, // missing
              { login: "bella", avatar_url: null },
              { login: "carol", avatar_url: "" },
              { login: "dora", avatar_url: "garbage" },
              {
                login: "eve",
                avatar_url: "https://avatars.githubusercontent.com/u/9?v=4",
              },
            ],
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
      pullNumber: "42",
      githubToken: null,
    });

    expect(summary.requestedUsers).toEqual([
      { login: "alice", avatarUrl: null },
      { login: "bella", avatarUrl: null },
      { login: "carol", avatarUrl: null },
      { login: "dora", avatarUrl: null },
      {
        login: "eve",
        avatarUrl: "https://avatars.githubusercontent.com/u/9?v=4",
      },
    ]);
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
      expect(message).toContain("GitHub App");
      expect(message).toContain("install the GitHub App");
      expect(message).not.toContain("repo scope");
      expect(message).not.toContain("SSO");
    }
  });

  it("rejects non-http(s) avatar_url schemes (javascript:, data:, file:) as null", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { login: "hon454" },
            requested_reviewers: [
              { login: "alice", avatar_url: "javascript:alert(1)" },
              { login: "bella", avatar_url: "data:text/html,<script>alert(1)</script>" },
              { login: "carol", avatar_url: "file:///etc/passwd" },
              {
                login: "dora",
                avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
              },
            ],
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
      pullNumber: "42",
      githubToken: null,
    });

    expect(summary.requestedUsers).toEqual([
      { login: "alice", avatarUrl: null },
      { login: "bella", avatarUrl: null },
      { login: "carol", avatarUrl: null },
      {
        login: "dora",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      },
    ]);
  });

  it("keeps CHANGES_REQUESTED when a later COMMENTED review is submitted by the same reviewer", async () => {
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
          JSON.stringify([
            {
              state: "CHANGES_REQUESTED",
              submitted_at: "2026-04-22T08:23:41Z",
              user: { login: "ryumiel", avatar_url: null },
            },
            {
              state: "COMMENTED",
              submitted_at: "2026-04-22T09:49:05Z",
              user: { login: "ryumiel", avatar_url: null },
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

    expect(summary.completedReviews).toEqual([
      { login: "ryumiel", avatarUrl: null, state: "CHANGES_REQUESTED" },
    ]);
  });

  it("keeps APPROVED when a later COMMENTED review is submitted by the same reviewer", async () => {
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
          JSON.stringify([
            {
              state: "APPROVED",
              submitted_at: "2026-04-20T12:00:00Z",
              user: { login: "bob", avatar_url: null },
            },
            {
              state: "COMMENTED",
              submitted_at: "2026-04-22T12:00:00Z",
              user: { login: "bob", avatar_url: null },
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

    expect(summary.completedReviews).toEqual([
      { login: "bob", avatarUrl: null, state: "APPROVED" },
    ]);
  });

  it("drops a stale requested reviewer when the latest review request predates CHANGES_REQUESTED", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              state: "CHANGES_REQUESTED",
              submitted_at: "2026-05-07T02:03:16Z",
              user: { login: "hon454", avatar_url: null },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              event: "review_requested",
              created_at: "2026-05-06T12:43:42Z",
              requested_reviewer: { login: "hon454", avatar_url: null },
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
      pullMetadata: {
        number: "42",
        authorLogin: "author",
        requestedUsers: [{ login: "hon454", avatarUrl: null }],
        requestedTeams: [],
      },
    });

    expect(summary).toEqual({
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [
        { login: "hon454", avatarUrl: null, state: "CHANGES_REQUESTED" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/hon454/github-pulls-show-reviewers/issues/42/events?per_page=100",
    );
  });

  it("keeps a requested reviewer when the latest review request follows the latest non-comment review", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              state: "APPROVED",
              submitted_at: "2026-05-07T02:03:16Z",
              user: { login: "alice", avatar_url: null },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              event: "review_requested",
              created_at: "2026-05-07T03:00:00Z",
              requested_reviewer: { login: "alice", avatar_url: null },
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
      pullMetadata: {
        number: "42",
        authorLogin: "author",
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        requestedTeams: [],
      },
    });

    expect(summary.requestedUsers).toEqual([
      { login: "alice", avatarUrl: null },
    ]);
    expect(summary.completedReviews).toEqual([
      { login: "alice", avatarUrl: null, state: "APPROVED" },
    ]);
  });

  it("does not fetch issue events when requested reviewers have no non-comment review overlap", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              state: "COMMENTED",
              submitted_at: "2026-05-07T02:03:16Z",
              user: { login: "alice", avatar_url: null },
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
      pullMetadata: {
        number: "42",
        authorLogin: "author",
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        requestedTeams: [],
      },
    });

    expect(summary.requestedUsers).toEqual([
      { login: "alice", avatarUrl: null },
    ]);
    expect(summary.completedReviews).toEqual([
      { login: "alice", avatarUrl: null, state: "COMMENTED" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows paginated issue events when resolving an ambiguous requested reviewer", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              state: "DISMISSED",
              submitted_at: "2026-05-07T02:03:16Z",
              user: { login: "alice", avatar_url: null },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: '<https://api.github.com/repos/hon454/github-pulls-show-reviewers/issues/42/events?per_page=100&page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              event: "review_requested",
              created_at: "2026-05-07T03:00:00Z",
              requested_reviewer: { login: "alice", avatar_url: null },
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
      pullMetadata: {
        number: "42",
        authorLogin: "author",
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        requestedTeams: [],
      },
    });

    expect(summary.requestedUsers).toEqual([
      { login: "alice", avatarUrl: null },
    ]);
    expect(fetchMock.mock.calls).toHaveLength(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://api.github.com/repos/hon454/github-pulls-show-reviewers/issues/42/events?per_page=100&page=2",
    );
  });

  it("falls back to completed review state when an ambiguous issue-events lookup fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              state: "CHANGES_REQUESTED",
              submitted_at: "2026-05-07T02:03:16Z",
              user: { login: "alice", avatar_url: null },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const summary = await fetchPullReviewerSummary({
      owner: "hon454",
      repo: "github-pulls-show-reviewers",
      pullNumber: "42",
      githubToken: null,
      pullMetadata: {
        number: "42",
        authorLogin: "author",
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        requestedTeams: [],
      },
    });

    expect(summary.requestedUsers).toEqual([]);
    expect(summary.completedReviews).toEqual([
      { login: "alice", avatarUrl: null, state: "CHANGES_REQUESTED" },
    ]);
  });

  it("rethrows AbortError from an ambiguous issue-events lookup", async () => {
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              state: "CHANGES_REQUESTED",
              submitted_at: "2026-05-07T02:03:16Z",
              user: { login: "alice", avatar_url: null },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockRejectedValueOnce(abortError);

    await expect(
      fetchPullReviewerSummary({
        owner: "hon454",
        repo: "github-pulls-show-reviewers",
        pullNumber: "42",
        githubToken: null,
        pullMetadata: {
          number: "42",
          authorLogin: "author",
          requestedUsers: [{ login: "alice", avatarUrl: null }],
          requestedTeams: [],
        },
      }),
    ).rejects.toBe(abortError);
  });

  it("warns and falls back when an ambiguous issue-events payload is malformed", async () => {
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              state: "CHANGES_REQUESTED",
              submitted_at: "2026-05-07T02:03:16Z",
              user: { login: "alice", avatar_url: null },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              event: "review_requested",
              created_at: 123,
              requested_reviewer: { login: "alice", avatar_url: null },
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
      pullMetadata: {
        number: "42",
        authorLogin: "author",
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        requestedTeams: [],
      },
    });

    expect(summary.requestedUsers).toEqual([]);
    expect(summary.completedReviews).toEqual([
      { login: "alice", avatarUrl: null, state: "CHANGES_REQUESTED" },
    ]);
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("unexpected response shape"),
      expect.any(Array),
    );
  });

  it("keeps DISMISSED when a later COMMENTED review is submitted by the same reviewer", async () => {
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
          JSON.stringify([
            {
              state: "DISMISSED",
              submitted_at: "2026-04-20T12:00:00Z",
              user: { login: "carol", avatar_url: null },
            },
            {
              state: "COMMENTED",
              submitted_at: "2026-04-22T12:00:00Z",
              user: { login: "carol", avatar_url: null },
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

    expect(summary.completedReviews).toEqual([
      { login: "carol", avatarUrl: null, state: "DISMISSED" },
    ]);
  });

  it("picks the latest COMMENTED when a reviewer has only COMMENTED reviews", async () => {
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
          JSON.stringify([
            {
              state: "COMMENTED",
              submitted_at: "2026-04-20T12:00:00Z",
              user: { login: "dkfhddla", avatar_url: "https://a" },
            },
            {
              state: "COMMENTED",
              submitted_at: "2026-04-22T12:00:00Z",
              user: { login: "dkfhddla", avatar_url: "https://b" },
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

    expect(summary.completedReviews).toEqual([
      { login: "dkfhddla", avatarUrl: "https://b", state: "COMMENTED" },
    ]);
  });

  it("throws GitHubApiSchemaError (not a bare ZodError) when the pull payload is malformed", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          // Missing required `user` field — violates pullSchema.
          JSON.stringify({
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

    await expect(
      fetchPullReviewerSummary({
        owner: "hon454",
        repo: "github-pulls-show-reviewers",
        pullNumber: "42",
        githubToken: null,
      }),
    ).rejects.toBeInstanceOf(GitHubApiSchemaError);

    // describeGitHubApiError renders a helpful message rather than leaking a
    // raw ZodError stack.
    try {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
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
      await fetchPullReviewerSummary({
        owner: "hon454",
        repo: "github-pulls-show-reviewers",
        pullNumber: "42",
        githubToken: null,
      });
      throw new Error("Expected fetchPullReviewerSummary to reject.");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiSchemaError);
      const message = describeGitHubApiError(error, { githubToken: null });
      expect(message).toContain("unexpected response shape");
      expect(message).toContain(
        "/repos/hon454/github-pulls-show-reviewers/pulls/42",
      );
    }
  });

  it("follows Link: rel=\"next\" so a later-page review wins over first-page data", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
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
          JSON.stringify([
            {
              state: "CHANGES_REQUESTED",
              submitted_at: "2026-04-20T12:00:00Z",
              user: { login: "frank", avatar_url: null },
            },
          ]),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: '<https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews?per_page=100&page=2>; rel="next", <https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews?per_page=100&page=2>; rel="last"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              state: "APPROVED",
              submitted_at: "2026-04-24T12:00:00Z",
              user: { login: "frank", avatar_url: null },
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

    expect(summary.completedReviews).toEqual([
      { login: "frank", avatarUrl: null, state: "APPROVED" },
    ]);

    expect(fetchMock.mock.calls).toHaveLength(3);
    const firstReviewsUrl = fetchMock.mock.calls[1]?.[0];
    expect(String(firstReviewsUrl)).toContain("per_page=100");
    const nextPageUrl = fetchMock.mock.calls[2]?.[0];
    expect(String(nextPageUrl)).toContain("page=2");
  });

  it("forwards AbortSignal to every paginated reviews request", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
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
          headers: {
            "Content-Type": "application/json",
            Link: '<https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews?per_page=100&page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await fetchPullReviewerSummary({
      owner: "hon454",
      repo: "github-pulls-show-reviewers",
      pullNumber: "42",
      githubToken: null,
      signal: controller.signal,
    });

    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.signal).toBe(controller.signal);
    }
  });

  it("reports the reviews endpoint when a later page fails", async () => {
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
          headers: {
            "Content-Type": "application/json",
            Link: '<https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews?per_page=100&page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: "API rate limit exceeded" }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-limit": "60",
            },
          },
        ),
      );

    try {
      await fetchPullReviewerSummary({
        owner: "hon454",
        repo: "github-pulls-show-reviewers",
        pullNumber: "42",
        githubToken: null,
      });
      throw new Error("Expected fetchPullReviewerSummary to reject.");
    } catch (error) {
      const message = describeGitHubApiError(error, { githubToken: null });
      expect(message).toContain(
        "/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews",
      );
      expect(message).toContain("unauthenticated rate limit");
    }
  });

  it("picks the latest non-COMMENTED review when multiple non-comment reviews exist", async () => {
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
          JSON.stringify([
            {
              state: "CHANGES_REQUESTED",
              submitted_at: "2026-04-20T12:00:00Z",
              user: { login: "eve", avatar_url: null },
            },
            {
              state: "APPROVED",
              submitted_at: "2026-04-21T12:00:00Z",
              user: { login: "eve", avatar_url: null },
            },
            {
              state: "COMMENTED",
              submitted_at: "2026-04-22T12:00:00Z",
              user: { login: "eve", avatar_url: null },
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

    expect(summary.completedReviews).toEqual([
      { login: "eve", avatarUrl: null, state: "APPROVED" },
    ]);
  });
});

describe("fetchPullReviewerMetadataBatch", () => {
  it("reads requested reviewer metadata for a page of pull requests without a token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              number: 42,
              user: { login: "hon454" },
              requested_reviewers: [
                {
                  login: "alice",
                  avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
                },
              ],
              requested_teams: [{ slug: "platform" }],
            },
            {
              number: 41,
              user: { login: "octocat" },
              requested_reviewers: [],
              requested_teams: [],
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const metadata = await fetchPullReviewerMetadataBatch({
      owner: "hon454",
      repo: "github-pulls-show-reviewers",
      githubToken: null,
    });

    expect(metadata).toEqual([
      {
        number: "42",
        authorLogin: "hon454",
        requestedUsers: [
          {
            login: "alice",
            avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
          },
        ],
        requestedTeams: ["platform"],
      },
      {
        number: "41",
        authorLogin: "octocat",
        requestedUsers: [],
        requestedTeams: [],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls?per_page=100&state=all",
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("Authorization")).toBeNull();
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

      const account =
        fixtureCase.token != null ? { token: fixtureCase.token } : null;
      const result = await validateGitHubRepositoryAccess(
        account,
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
