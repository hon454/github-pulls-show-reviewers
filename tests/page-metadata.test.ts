import { describe, expect, it, vi } from "vitest";

import type { PullReviewerMetadata } from "../src/github/api";
import type { FallbackAccountIntegration } from "../src/features/reviewers/fallback-account";
import { createPageMetadataCoordinator } from "../src/features/reviewers/page-metadata";
import type { Account } from "../src/storage/accounts";

const route = { owner: "acme", repo: "widgets" };
const metadata: PullReviewerMetadata = {
  number: "42",
  authorLogin: "author",
  requestedUsers: [],
  requestedTeams: [],
};

function makeAccount(id = "acc-1"): Account {
  return {
    id,
    login: id,
    avatarUrl: null,
    token: "ghu_example",
    createdAt: 1,
    installations: [],
    installationsRefreshedAt: 1,
    invalidated: false,
    invalidatedReason: null,
    refreshToken: null,
    expiresAt: null,
    refreshTokenExpiresAt: null,
  };
}

function fallbackAccounts(
  overrides: Partial<FallbackAccountIntegration> = {},
): FallbackAccountIntegration {
  return {
    read: vi.fn(() => undefined),
    get: vi.fn(async () => null),
    clear: vi.fn(),
    ...overrides,
  };
}

describe("page metadata coordinator", () => {
  it("deduplicates matching in-flight requests", async () => {
    let resolveFetch: ((value: PullReviewerMetadata[]) => void) | undefined;
    const fetchMetadata = vi.fn(
      () =>
        new Promise<PullReviewerMetadata[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const coordinator = createPageMetadataCoordinator({
      fallbackAccounts: fallbackAccounts(),
      fetchMetadata,
    });
    const signal = new AbortController().signal;

    const first = coordinator.get({
      route,
      account: null,
      targetPullNumbers: ["42"],
      signal,
    });
    const second = coordinator.get({
      route,
      account: null,
      targetPullNumbers: ["42"],
      signal,
    });
    resolveFetch?.([metadata]);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.metadata.get("42")).toEqual(metadata);
    expect(secondResult.metadata.get("42")).toEqual(metadata);
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
  });

  it("reuses fresh exact cache entries and refetches after staleness", async () => {
    let now = 1_000;
    const fetchMetadata = vi.fn().mockResolvedValue([metadata]);
    const coordinator = createPageMetadataCoordinator({
      fallbackAccounts: fallbackAccounts(),
      fetchMetadata,
      now: () => now,
    });
    const request = {
      route,
      account: null,
      targetPullNumbers: ["42"],
      signal: new AbortController().signal,
    };

    await coordinator.get(request);
    await coordinator.get(request);
    expect(fetchMetadata).toHaveBeenCalledTimes(1);

    coordinator.markStale();
    now += 1;
    await coordinator.get(request);
    expect(fetchMetadata).toHaveBeenCalledTimes(2);
  });

  it("retries an auth-like public request failure with the fallback account", async () => {
    const account = makeAccount();
    const fallback = fallbackAccounts({
      get: vi.fn(async () => account),
    });
    const fetchMetadata = vi
      .fn()
      .mockRejectedValueOnce({ status: 403 })
      .mockResolvedValueOnce([metadata]);
    const coordinator = createPageMetadataCoordinator({
      fallbackAccounts: fallback,
      fetchMetadata,
    });

    const result = await coordinator.get({
      route,
      account: null,
      targetPullNumbers: ["42"],
      signal: new AbortController().signal,
    });

    expect(result.failure).toBeNull();
    expect(result.metadata.get("42")).toEqual(metadata);
    expect(fallback.get).toHaveBeenCalledWith("acme");
    expect(fetchMetadata).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ account }),
    );
  });

  it("returns one reportable page failure when no fallback account is available", async () => {
    const error = { status: 429 };
    const coordinator = createPageMetadataCoordinator({
      fallbackAccounts: fallbackAccounts(),
      fetchMetadata: vi.fn().mockRejectedValue(error),
    });

    const result = await coordinator.get({
      route,
      account: null,
      targetPullNumbers: ["42"],
      signal: new AbortController().signal,
    });

    expect(result.metadata.size).toBe(0);
    expect(result.failure).toEqual({
      account: null,
      error,
      reported: false,
      suppressRowFallback: true,
    });
  });
});
