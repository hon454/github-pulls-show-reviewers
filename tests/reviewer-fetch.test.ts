import { describe, expect, it } from "vitest";

import {
  GitHubApiError,
  GitHubPullRequestEndpointsError,
} from "../src/github/api";
import {
  extractReviewerFetchFailures,
  fetchPullReviewerMetadataBatchResponseSchema,
  fetchPullReviewerSummaryResponseSchema,
  serializeReviewerFetchError,
} from "../src/runtime/reviewer-fetch";
import { contentAccountSchema } from "../src/runtime/ui-contract";

const pullEndpoint = {
  name: "pull" as const,
  method: "GET" as const,
  path: "/repos/cinev/shotloom/pulls/42",
};
const reviewsEndpoint = {
  name: "reviews" as const,
  method: "GET" as const,
  path: "/repos/cinev/shotloom/pulls/42/reviews",
};

describe("fetchPullReviewerSummaryResponseSchema", () => {
  const baseSummary = {
    status: "ok" as const,
    requestedUsers: [{ login: "alice", avatarUrl: null }],
    requestedTeams: [],
    completedReviews: [
      { login: "alice", avatarUrl: null, state: "APPROVED" as const },
    ],
  };

  it("round-trips confirmed and unverified request evidence", () => {
    const parsed = fetchPullReviewerSummaryResponseSchema.parse({
      ok: true,
      summary: {
        ...baseSummary,
        reviewRequestEvidence: [
          { login: "alice", status: "unverified" },
          { login: "bob", status: "confirmed" },
        ],
      },
    });

    expect(parsed).toMatchObject({
      ok: true,
      summary: {
        reviewRequestEvidence: [
          { login: "alice", status: "unverified" },
          { login: "bob", status: "confirmed" },
        ],
      },
    });
  });

  it("accepts a legacy summary without request evidence", () => {
    const parsed = fetchPullReviewerSummaryResponseSchema.parse({
      ok: true,
      summary: baseSummary,
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.summary.reviewRequestEvidence).toBeUndefined();
    }
  });
});

describe("strict content reply schemas", () => {
  const account = { id: "acc-1", revision: "g1", invalidated: false };
  const summary = {
    status: "ok" as const,
    requestedUsers: [],
    requestedTeams: [],
    completedReviews: [],
  };
  const error = { kind: "unknown" as const, status: null };
  const identity = {
    login: "octocat",
    avatarUrl: null,
    installations: [{ id: 1, account: { login: "octo", type: "User" } }],
  };

  it("accepts the account projection on every reply variant", () => {
    for (const reply of [
      { ok: true, summary, account },
      { ok: false, error, account },
    ])
      expect(fetchPullReviewerSummaryResponseSchema.parse(reply)).toEqual(
        reply,
      );
    for (const reply of [
      { ok: true, metadata: [], account },
      { ok: false, error, account: null },
    ])
      expect(fetchPullReviewerMetadataBatchResponseSchema.parse(reply)).toEqual(
        reply,
      );
  });

  it.each(Object.keys(identity))(
    "rejects an account that carries %s",
    (key) => {
      const leaked = {
        ...account,
        [key]: identity[key as keyof typeof identity],
      };
      expect(contentAccountSchema.safeParse(leaked).success).toBe(false);
      for (const reply of [
        { ok: true, summary, account: leaked },
        { ok: false, error, account: leaked },
      ])
        expect(
          fetchPullReviewerSummaryResponseSchema.safeParse(reply).success,
        ).toBe(false);
      for (const reply of [
        { ok: true, metadata: [], account: leaked },
        { ok: false, error, account: leaked },
      ])
        expect(
          fetchPullReviewerMetadataBatchResponseSchema.safeParse(reply).success,
        ).toBe(false);
    },
  );

  it("rejects extra fields at the reply, summary, metadata and error levels", () => {
    for (const reply of [
      { ok: true, summary, account, accountSummary: identity },
      { ok: true, summary: { ...summary, viewer: "octocat" } },
      { ok: false, error: { ...error, message: "raw" } },
      {
        ok: false,
        error: {
          ...error,
          failures: [
            { status: 401, endpoint: null, rateLimited: false, body: "raw" },
          ],
        },
      },
    ])
      expect(
        fetchPullReviewerSummaryResponseSchema.safeParse(reply).success,
      ).toBe(false);
    expect(
      fetchPullReviewerMetadataBatchResponseSchema.safeParse({
        ok: true,
        metadata: [
          {
            number: "1",
            authorLogin: null,
            requestedUsers: [],
            requestedTeams: [],
            installation: 1,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("serializeReviewerFetchError", () => {
  it("flags rateLimited=true and carries the rate-limit snapshot when GitHub headers are present", () => {
    const error = new GitHubApiError(403, undefined, pullEndpoint, {
      limit: 60,
      remaining: 0,
      resource: "core",
      resetAt: 1,
    });

    const envelope = serializeReviewerFetchError(error);

    expect(envelope.kind).toBe("github-api");
    expect(envelope.failures).toEqual([
      {
        status: 403,
        endpoint: pullEndpoint.path,
        rateLimited: true,
        rateLimit: { limit: 60, remaining: 0, resource: "core", resetAt: 1 },
      },
    ]);
  });

  it("flags rateLimited=false and omits the snapshot when the GitHubApiError is a 404 with no rate-limit signal", () => {
    const error = new GitHubApiError(404, undefined, pullEndpoint);

    const envelope = serializeReviewerFetchError(error);

    expect(envelope.failures).toEqual([
      { status: 404, endpoint: pullEndpoint.path, rateLimited: false },
    ]);
  });

  it("preserves rateLimited per failure inside a GitHubPullRequestEndpointsError and carries the snapshot only on the rate-limit failure", () => {
    const error = new GitHubPullRequestEndpointsError([
      new GitHubApiError(404, undefined, pullEndpoint),
      new GitHubApiError(429, undefined, reviewsEndpoint, {
        limit: 5_000,
        remaining: 0,
        resource: "core",
        resetAt: 9_999,
      }),
    ]);

    const envelope = serializeReviewerFetchError(error);

    expect(envelope.kind).toBe("github-endpoints");
    expect(envelope.failures).toEqual([
      { status: 404, endpoint: pullEndpoint.path, rateLimited: false },
      {
        status: 429,
        endpoint: reviewsEndpoint.path,
        rateLimited: true,
        rateLimit: {
          limit: 5_000,
          remaining: 0,
          resource: "core",
          resetAt: 9_999,
        },
      },
    ]);
  });

  it("omits the rate-limit snapshot when every header is null", () => {
    const error = new GitHubApiError(429, undefined, pullEndpoint, {
      limit: null,
      remaining: null,
      resource: null,
      resetAt: null,
    });

    const envelope = serializeReviewerFetchError(error);

    expect(envelope.failures?.[0]).toMatchObject({ rateLimited: true });
    expect(envelope.failures?.[0]?.rateLimit).toBeUndefined();
  });
});

describe("extractReviewerFetchFailures", () => {
  it("computes rateLimited and carries the snapshot from a live GitHubApiError instance", () => {
    const error = new GitHubApiError(403, undefined, pullEndpoint, {
      limit: 60,
      remaining: 0,
      resource: "core",
      resetAt: 1,
    });

    expect(extractReviewerFetchFailures(error)).toEqual([
      {
        status: 403,
        endpoint: pullEndpoint.path,
        rateLimited: true,
        rateLimit: { limit: 60, remaining: 0, resource: "core", resetAt: 1 },
      },
    ]);
  });

  it("reads rateLimited from an already-serialized envelope object", () => {
    const envelope = {
      kind: "github-endpoints" as const,
      status: 403,
      failures: [
        {
          status: 403,
          endpoint: "/repos/cinev/shotloom/pulls/42",
          rateLimited: true,
        },
        {
          status: 404,
          endpoint: "/repos/cinev/shotloom/pulls/42/reviews",
          rateLimited: false,
        },
      ],
    };

    expect(extractReviewerFetchFailures(envelope)).toEqual([
      {
        status: 403,
        endpoint: "/repos/cinev/shotloom/pulls/42",
        rateLimited: true,
      },
      {
        status: 404,
        endpoint: "/repos/cinev/shotloom/pulls/42/reviews",
        rateLimited: false,
      },
    ]);
  });

  it("preserves the rate-limit snapshot when the envelope already includes one", () => {
    const envelope = {
      kind: "github-api" as const,
      status: 429,
      failures: [
        {
          status: 429,
          endpoint: "/repos/cinev/shotloom/pulls/42",
          rateLimited: true,
          rateLimit: {
            limit: 5_000,
            remaining: 0,
            resource: "core",
            resetAt: 1_700_000_000,
          },
        },
      ],
    };

    expect(extractReviewerFetchFailures(envelope)).toEqual([
      {
        status: 429,
        endpoint: "/repos/cinev/shotloom/pulls/42",
        rateLimited: true,
        rateLimit: {
          limit: 5_000,
          remaining: 0,
          resource: "core",
          resetAt: 1_700_000_000,
        },
      },
    ]);
  });

  it("defaults rateLimited to false when the envelope object omits the field (backward compatibility)", () => {
    const envelope = {
      kind: "github-endpoints" as const,
      status: 404,
      failures: [{ status: 404, endpoint: null }],
    };

    expect(extractReviewerFetchFailures(envelope)).toEqual([
      { status: 404, endpoint: null, rateLimited: false },
    ]);
  });
});

it("serializes typed timeout independently of HTTP and external AbortError", async () => {
  const { ReviewerTimeoutError } =
    await import("../src/shared/reviewer-deadline");
  const { reviewerFetchErrorSchema } =
    await import("../src/runtime/reviewer-fetch");
  const envelope = serializeReviewerFetchError(new ReviewerTimeoutError());
  expect(reviewerFetchErrorSchema.parse(envelope)).toEqual({
    kind: "unknown",
    status: null,
    failures: [
      { kind: "timeout", status: null, endpoint: null, rateLimited: false },
    ],
  });
  expect(extractReviewerFetchFailures(envelope)[0].kind).toBe("timeout");
  expect(
    serializeReviewerFetchError(new DOMException("canceled", "AbortError"))
      .failures?.[0].kind,
  ).toBe("cancellation");
});
