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
  it("flags rateLimited=true when the GitHubApiError signals rate-limit headers", () => {
    const error = new GitHubApiError(
      403,
      undefined,
      pullEndpoint,
      { limit: 60, remaining: 0, resource: "core", resetAt: 1 },
    );

    const envelope = serializeReviewerFetchError(error);

    expect(envelope.kind).toBe("github-api");
    expect(envelope.failures).toEqual([
      { status: 403, endpoint: pullEndpoint.path, rateLimited: true },
    ]);
  });

  it("flags rateLimited=false when the GitHubApiError is a 404 with no rate-limit signal", () => {
    const error = new GitHubApiError(404, undefined, pullEndpoint);

    const envelope = serializeReviewerFetchError(error);

    expect(envelope.failures).toEqual([
      { status: 404, endpoint: pullEndpoint.path, rateLimited: false },
    ]);
  });

  it("preserves rateLimited per failure inside a GitHubPullRequestEndpointsError", () => {
    const error = new GitHubPullRequestEndpointsError([
      new GitHubApiError(404, undefined, pullEndpoint),
      new GitHubApiError(429, undefined, reviewsEndpoint),
    ]);

    const envelope = serializeReviewerFetchError(error);

    expect(envelope.kind).toBe("github-endpoints");
    expect(envelope.failures).toEqual([
      { status: 404, endpoint: pullEndpoint.path, rateLimited: false },
      { status: 429, endpoint: reviewsEndpoint.path, rateLimited: true },
    ]);
  });
});

describe("extractReviewerFetchFailures", () => {
  it("computes rateLimited from a live GitHubApiError instance", () => {
    const error = new GitHubApiError(
      403,
      undefined,
      pullEndpoint,
      { limit: 60, remaining: 0, resource: "core", resetAt: 1 },
    );

    expect(extractReviewerFetchFailures(error)).toEqual([
      { status: 403, endpoint: pullEndpoint.path, rateLimited: true },
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
