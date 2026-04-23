import { afterEach, describe, expect, it } from "vitest";

import type { PullReviewerSummary } from "../src/github/api";
import {
  __resetReviewerCacheMaxEntriesForTesting,
  __setReviewerCacheMaxEntriesForTesting,
  buildReviewerCacheKey,
  clearReviewerCache,
  getCachedReviewerSummary,
  setCachedReviewerSummary,
} from "../src/cache/reviewer-cache";

function summary(login: string): PullReviewerSummary {
  return {
    status: "ok",
    requestedUsers: [{ login, avatarUrl: null }],
    requestedTeams: [],
    completedReviews: [],
  };
}

afterEach(() => {
  clearReviewerCache();
  __resetReviewerCacheMaxEntriesForTesting();
});

describe("reviewer cache", () => {
  it("stores and returns summaries by key", () => {
    const key = buildReviewerCacheKey("cinev", "shotloom", "1");
    setCachedReviewerSummary(key, summary("alice"));
    const got = getCachedReviewerSummary(key);
    expect(got?.requestedUsers[0].login).toBe("alice");
  });

  it("evicts the least-recently-inserted entry when exceeding the bound", () => {
    __setReviewerCacheMaxEntriesForTesting(2);
    const a = buildReviewerCacheKey("org", "repo", "1");
    const b = buildReviewerCacheKey("org", "repo", "2");
    const c = buildReviewerCacheKey("org", "repo", "3");
    setCachedReviewerSummary(a, summary("a"));
    setCachedReviewerSummary(b, summary("b"));
    setCachedReviewerSummary(c, summary("c"));
    expect(getCachedReviewerSummary(a)).toBeUndefined();
    expect(getCachedReviewerSummary(b)?.requestedUsers[0].login).toBe("b");
    expect(getCachedReviewerSummary(c)?.requestedUsers[0].login).toBe("c");
  });

  it("promotes a read entry so the next eviction targets a cold key", () => {
    __setReviewerCacheMaxEntriesForTesting(2);
    const a = buildReviewerCacheKey("org", "repo", "1");
    const b = buildReviewerCacheKey("org", "repo", "2");
    const c = buildReviewerCacheKey("org", "repo", "3");
    setCachedReviewerSummary(a, summary("a"));
    setCachedReviewerSummary(b, summary("b"));
    // Touch `a` so it becomes most-recently-used; `b` is now the coldest.
    expect(getCachedReviewerSummary(a)?.requestedUsers[0].login).toBe("a");
    setCachedReviewerSummary(c, summary("c"));
    expect(getCachedReviewerSummary(b)).toBeUndefined();
    expect(getCachedReviewerSummary(a)?.requestedUsers[0].login).toBe("a");
    expect(getCachedReviewerSummary(c)?.requestedUsers[0].login).toBe("c");
  });

  it("overwrites an existing entry without growing beyond the bound", () => {
    __setReviewerCacheMaxEntriesForTesting(2);
    const a = buildReviewerCacheKey("org", "repo", "1");
    const b = buildReviewerCacheKey("org", "repo", "2");
    setCachedReviewerSummary(a, summary("a"));
    setCachedReviewerSummary(b, summary("b"));
    setCachedReviewerSummary(a, summary("a2"));
    expect(getCachedReviewerSummary(a)?.requestedUsers[0].login).toBe("a2");
    expect(getCachedReviewerSummary(b)?.requestedUsers[0].login).toBe("b");
  });
});
