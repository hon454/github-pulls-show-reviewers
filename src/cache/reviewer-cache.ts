import type { PullReviewerSummary } from "../github/api";

export type CacheKey = `${string}/${string}#${string}`;

const DEFAULT_MAX_ENTRIES = 500;

let maxEntries = DEFAULT_MAX_ENTRIES;
const reviewerCache = new Map<CacheKey, PullReviewerSummary>();

export function getCachedReviewerSummary(key: CacheKey): PullReviewerSummary | undefined {
  const value = reviewerCache.get(key);
  if (value !== undefined) {
    // LRU: re-insert to move the entry to the most-recently-used end.
    reviewerCache.delete(key);
    reviewerCache.set(key, value);
  }
  return value;
}

export function setCachedReviewerSummary(key: CacheKey, value: PullReviewerSummary): void {
  if (reviewerCache.has(key)) {
    reviewerCache.delete(key);
  }
  reviewerCache.set(key, value);
  while (reviewerCache.size > maxEntries) {
    const oldest = reviewerCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    reviewerCache.delete(oldest);
  }
}

export function buildReviewerCacheKey(owner: string, repo: string, pullNumber: string): CacheKey {
  return `${owner}/${repo}#${pullNumber}`;
}

export function clearReviewerCache(): void {
  reviewerCache.clear();
}

/**
 * Override the LRU bound. Intended for tests; production code uses the
 * default.
 */
export function __setReviewerCacheMaxEntriesForTesting(limit: number): void {
  maxEntries = limit;
}

export function __resetReviewerCacheMaxEntriesForTesting(): void {
  maxEntries = DEFAULT_MAX_ENTRIES;
}
