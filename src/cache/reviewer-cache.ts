import type { PullReviewerSummary } from "~/github/api";

type CacheKey = `${string}/${string}#${string}`;

const reviewerCache = new Map<CacheKey, PullReviewerSummary>();

export function getCachedReviewerSummary(key: CacheKey): PullReviewerSummary | undefined {
  return reviewerCache.get(key);
}

export function setCachedReviewerSummary(key: CacheKey, value: PullReviewerSummary): void {
  reviewerCache.set(key, value);
}

export function buildReviewerCacheKey(owner: string, repo: string, pullNumber: string): CacheKey {
  return `${owner}/${repo}#${pullNumber}`;
}
