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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
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
  it("does not start a request for an already-aborted parent signal", async () => {
    const fetchMetadata = vi.fn().mockResolvedValue([metadata]);
    const fallback = fallbackAccounts();
    const coordinator = createPageMetadataCoordinator({
      fallbackAccounts: fallback,
      fetchMetadata,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await coordinator.get({
      route,
      account: null,
      targetPullNumbers: ["42"],
      signal: controller.signal,
    });

    expect(result.metadata.size).toBe(0);
    expect(result.failure).toBeNull();
    expect(fetchMetadata).not.toHaveBeenCalled();
    expect(fallback.read).not.toHaveBeenCalled();
    expect(fallback.get).not.toHaveBeenCalled();
  });

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

  it("does not cache or retry after aborting during a fallback lookup", async () => {
    const lookup = createDeferred<Account | null>();
    const fetchMetadata = vi
      .fn()
      .mockRejectedValueOnce({ status: 403 })
      .mockResolvedValueOnce([metadata]);
    const fallback = fallbackAccounts({
      get: vi.fn(() => lookup.promise),
    });
    const coordinator = createPageMetadataCoordinator({
      fallbackAccounts: fallback,
      fetchMetadata,
    });
    const controller = new AbortController();

    const abortedRequest = coordinator.get({
      route,
      account: null,
      targetPullNumbers: ["42"],
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(fallback.get).toHaveBeenCalledTimes(1);
    });

    controller.abort();
    lookup.resolve(makeAccount("fallback"));

    const abortedResult = await abortedRequest;
    expect(abortedResult.metadata.size).toBe(0);
    expect(abortedResult.failure).toBeNull();
    expect(fetchMetadata).toHaveBeenCalledTimes(1);

    const nextResult = await coordinator.get({
      route,
      account: null,
      targetPullNumbers: ["42"],
      signal: new AbortController().signal,
    });
    expect(nextResult.metadata.get("42")).toEqual(metadata);
    expect(nextResult.failure).toBeNull();
    expect(fetchMetadata).toHaveBeenCalledTimes(2);
  });
});
