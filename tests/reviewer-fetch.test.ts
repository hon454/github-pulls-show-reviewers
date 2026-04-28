import { describe, expect, it } from "vitest";

import { GitHubApiError, GitHubPullRequestEndpointsError } from "../src/github/api";
import {
  extractReviewerFetchFailures,
  serializeReviewerFetchError,
} from "../src/runtime/reviewer-fetch";

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

describe("serializeReviewerFetchError", () => {
  it("flags rateLimited=true and carries the rate-limit snapshot when GitHub headers are present", () => {
    const error = new GitHubApiError(
      403,
      undefined,
      pullEndpoint,
      { limit: 60, remaining: 0, resource: "core", resetAt: 1 },
    );

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
    const error = new GitHubApiError(
      429,
      undefined,
      pullEndpoint,
      { limit: null, remaining: null, resource: null, resetAt: null },
    );

    const envelope = serializeReviewerFetchError(error);

    expect(envelope.failures?.[0]).toMatchObject({ rateLimited: true });
    expect(envelope.failures?.[0]?.rateLimit).toBeUndefined();
  });
});

describe("extractReviewerFetchFailures", () => {
  it("computes rateLimited and carries the snapshot from a live GitHubApiError instance", () => {
    const error = new GitHubApiError(
      403,
      undefined,
      pullEndpoint,
      { limit: 60, remaining: 0, resource: "core", resetAt: 1 },
    );

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
        { status: 403, endpoint: "/repos/cinev/shotloom/pulls/42", rateLimited: true },
        { status: 404, endpoint: "/repos/cinev/shotloom/pulls/42/reviews", rateLimited: false },
      ],
    };

    expect(extractReviewerFetchFailures(envelope)).toEqual([
      { status: 403, endpoint: "/repos/cinev/shotloom/pulls/42", rateLimited: true },
      { status: 404, endpoint: "/repos/cinev/shotloom/pulls/42/reviews", rateLimited: false },
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
