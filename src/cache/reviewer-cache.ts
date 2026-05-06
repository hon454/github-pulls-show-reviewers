import type { PullReviewerSummary } from "../github/api";

export type CacheKey = `${string}/${string}#${string}`;
export type ReviewerCacheEntry = {
  summary: PullReviewerSummary;
  fetchedAt: number;
  stale: boolean;
};

const DEFAULT_MAX_ENTRIES = 500;
export const REVIEWER_SUMMARY_FRESH_MS = 30_000;

let maxEntries = DEFAULT_MAX_ENTRIES;
const reviewerCache = new Map<CacheKey, ReviewerCacheEntry>();

function promoteEntry(key: CacheKey): ReviewerCacheEntry | undefined {
  const value = reviewerCache.get(key);
  if (value !== undefined) {
    // LRU: re-insert to move the entry to the most-recently-used end.
    reviewerCache.delete(key);
    reviewerCache.set(key, value);
  }
  return value;
}

export function getCachedReviewerSummary(
  key: CacheKey,
): PullReviewerSummary | undefined {
  return promoteEntry(key)?.summary;
}

export function getReviewerCacheEntry(
  key: CacheKey,
): ReviewerCacheEntry | undefined {
  return promoteEntry(key);
}

export function isReviewerCacheEntryFresh(
  entry: ReviewerCacheEntry,
  now = Date.now(),
): boolean {
  return !entry.stale && now - entry.fetchedAt <= REVIEWER_SUMMARY_FRESH_MS;
}

export function setCachedReviewerSummary(
  key: CacheKey,
  value: PullReviewerSummary,
  options: { fetchedAt?: number } = {},
): void {
  if (reviewerCache.has(key)) {
    reviewerCache.delete(key);
  }
  reviewerCache.set(key, {
    summary: value,
    fetchedAt: options.fetchedAt ?? Date.now(),
    stale: false,
  });
  while (reviewerCache.size > maxEntries) {
    const oldest = reviewerCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    reviewerCache.delete(oldest);
  }
}

export function buildReviewerCacheKey(
  owner: string,
  repo: string,
  pullNumber: string,
): CacheKey {
  return `${owner}/${repo}#${pullNumber}`;
}

export function markReviewerCacheStale(key: CacheKey): void {
  const entry = reviewerCache.get(key);
  if (entry == null) return;
  reviewerCache.set(key, { ...entry, stale: true });
}

export function markReviewerCacheStaleForRepository(
  owner: string,
  repo: string,
): void {
  const prefix = `${owner}/${repo}#`;
  for (const [key, entry] of reviewerCache) {
    if (key.startsWith(prefix)) {
      reviewerCache.set(key, { ...entry, stale: true });
    }
  }
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
