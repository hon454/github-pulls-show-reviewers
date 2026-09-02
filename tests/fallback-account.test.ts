import { describe, expect, it, vi } from "vitest";

import { createFallbackAccountIntegration } from "../src/features/reviewers/fallback-account";
import type { Account } from "../src/storage/accounts";

function makeAccount(id: string): Account {
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

describe("fallback account integration", () => {
  it("deduplicates concurrent owner lookups and caches the result", async () => {
    const account = makeAccount("acc-1");
    const resolve = vi.fn().mockResolvedValue(account);
    const integration = createFallbackAccountIntegration(resolve);

    const [first, second] = await Promise.all([
      integration.get("acme"),
      integration.get("acme"),
    ]);

    expect(first).toBe(account);
    expect(second).toBe(account);
    expect(integration.read("acme")).toBe(account);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("caches a null result for the owner", async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    const integration = createFallbackAccountIntegration(resolve);

    await expect(integration.get("acme")).resolves.toBeNull();
    await expect(integration.get("acme")).resolves.toBeNull();

    expect(integration.read("acme")).toBeNull();
    expect(integration.read("other")).toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("clears cached resolution after account storage changes", async () => {
    const first = makeAccount("acc-1");
    const second = makeAccount("acc-2");
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const integration = createFallbackAccountIntegration(resolve);

    await expect(integration.get("acme")).resolves.toBe(first);
    integration.clear();
    expect(integration.read("acme")).toBeUndefined();
    await expect(integration.get("acme")).resolves.toBe(second);
  });
});
