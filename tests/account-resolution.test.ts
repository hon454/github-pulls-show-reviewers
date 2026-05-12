import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSelfHealingAccountResolver } from "../src/features/reviewers/account-resolution";
import type { Account } from "../src/storage/accounts";

const resolveAccountForRepoMock = vi.hoisted(() => vi.fn());
const listAccountsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/storage/accounts", () => ({
  resolveAccountForRepo: resolveAccountForRepoMock,
  listAccounts: listAccountsMock,
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    login: "reviewer",
    avatarUrl: null,
    token: "ghu_x",
    createdAt: 1,
    installations: [],
    installationsRefreshedAt: 1,
    invalidated: false,
    invalidatedReason: null,
    refreshToken: "ghr_x",
    expiresAt: null,
    refreshTokenExpiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  resolveAccountForRepoMock.mockReset();
  listAccountsMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSelfHealingAccountResolver", () => {
  it("returns the cached-resolution result without refreshing when an account already covers the repo", async () => {
    const account = makeAccount();
    resolveAccountForRepoMock.mockResolvedValueOnce(account);
    const requestRefresh = vi.fn();

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    const result = await resolver.resolveAccount("acme", "widgets");

    expect(result).toBe(account);
    expect(listAccountsMock).not.toHaveBeenCalled();
    expect(requestRefresh).not.toHaveBeenCalled();
  });

  it("returns null without refreshing when no account has any installation on the owner", async () => {
    resolveAccountForRepoMock.mockResolvedValueOnce(null);
    listAccountsMock.mockResolvedValueOnce([
      makeAccount({
        id: "acc-other",
        installations: [
          {
            id: 1,
            account: {
              login: "different-org",
              type: "Organization",
              avatarUrl: null,
            },
            repositorySelection: "all",
            repoFullNames: null,
          },
        ],
      }),
    ]);
    const requestRefresh = vi.fn();

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    const result = await resolver.resolveAccount("acme", "widgets");

    expect(result).toBeNull();
    expect(requestRefresh).not.toHaveBeenCalled();
  });

  it("triggers a refresh for an account with a stale 'selected' installation on the owner and re-resolves", async () => {
    const accountAfter = makeAccount({
      id: "acc-stale",
      installations: [
        {
          id: 7,
          account: { login: "acme", type: "Organization", avatarUrl: null },
          repositorySelection: "selected",
          repoFullNames: ["acme/widgets"],
        },
      ],
    });
    const accountBefore = makeAccount({
      id: "acc-stale",
      installations: [
        {
          id: 7,
          account: { login: "acme", type: "Organization", avatarUrl: null },
          repositorySelection: "selected",
          repoFullNames: ["acme/legacy"],
        },
      ],
    });
    resolveAccountForRepoMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(accountAfter);
    listAccountsMock.mockResolvedValueOnce([accountBefore]);
    const requestRefresh = vi.fn().mockResolvedValue(true);

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    const result = await resolver.resolveAccount("acme", "widgets");

    expect(requestRefresh).toHaveBeenCalledTimes(1);
    expect(requestRefresh).toHaveBeenCalledWith("acc-stale");
    expect(result).toBe(accountAfter);
    expect(resolveAccountForRepoMock).toHaveBeenCalledTimes(2);
  });

  it("treats a 'selected' installation with a missing repoFullNames list as a stale candidate", async () => {
    resolveAccountForRepoMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    listAccountsMock.mockResolvedValueOnce([
      makeAccount({
        id: "acc-empty",
        installations: [
          {
            id: 4,
            account: { login: "acme", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
            repoFullNames: null,
          },
        ],
      }),
    ]);
    const requestRefresh = vi.fn().mockResolvedValue(true);

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    await resolver.resolveAccount("acme", "widgets");

    expect(requestRefresh).toHaveBeenCalledWith("acc-empty");
  });

  it("skips invalidated accounts when picking refresh candidates", async () => {
    resolveAccountForRepoMock.mockResolvedValueOnce(null);
    listAccountsMock.mockResolvedValueOnce([
      makeAccount({
        id: "acc-dead",
        invalidated: true,
        installations: [
          {
            id: 1,
            account: { login: "acme", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
            repoFullNames: [],
          },
        ],
      }),
    ]);
    const requestRefresh = vi.fn().mockResolvedValue(true);

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    const result = await resolver.resolveAccount("acme", "widgets");

    expect(requestRefresh).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("refreshes each candidate account at most once per page session, even across many calls", async () => {
    resolveAccountForRepoMock.mockResolvedValue(null);
    listAccountsMock.mockResolvedValue([
      makeAccount({
        id: "acc-stale",
        installations: [
          {
            id: 7,
            account: { login: "acme", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
            repoFullNames: [],
          },
        ],
      }),
    ]);
    const requestRefresh = vi.fn().mockResolvedValue(true);

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    await resolver.resolveAccount("acme", "widgets");
    await resolver.resolveAccount("acme", "gadgets");
    await resolver.resolveAccount("acme", "trinkets");

    expect(requestRefresh).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent calls into a single in-flight refresh per account", async () => {
    resolveAccountForRepoMock.mockResolvedValue(null);
    listAccountsMock.mockResolvedValue([
      makeAccount({
        id: "acc-stale",
        installations: [
          {
            id: 7,
            account: { login: "acme", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
            repoFullNames: [],
          },
        ],
      }),
    ]);
    let resolveRefresh: (value: boolean) => void = () => {};
    const requestRefresh = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    const a = resolver.resolveAccount("acme", "widgets");
    const b = resolver.resolveAccount("acme", "gadgets");

    await new Promise((resolve) => setTimeout(resolve, 0));

    resolveRefresh(true);
    await Promise.all([a, b]);

    expect(requestRefresh).toHaveBeenCalledTimes(1);
  });

  it("matches the owner case-insensitively when finding refresh candidates", async () => {
    resolveAccountForRepoMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    listAccountsMock.mockResolvedValueOnce([
      makeAccount({
        id: "acc-mixed",
        installations: [
          {
            id: 11,
            account: { login: "AcMe", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
            repoFullNames: [],
          },
        ],
      }),
    ]);
    const requestRefresh = vi.fn().mockResolvedValue(true);

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    await resolver.resolveAccount("acme", "widgets");

    expect(requestRefresh).toHaveBeenCalledWith("acc-mixed");
  });

  it("does not call requestRefresh when the only matching installation already covers the repo (defensive guard)", async () => {
    // resolveAccountForRepo would have returned the account here, so this is
    // belt-and-suspenders: if listAccounts shows a matching repo for an
    // installation, we should not flag that account as stale.
    resolveAccountForRepoMock.mockResolvedValueOnce(null);
    listAccountsMock.mockResolvedValueOnce([
      makeAccount({
        id: "acc-fresh",
        installations: [
          {
            id: 5,
            account: { login: "acme", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
            repoFullNames: ["acme/widgets"],
          },
        ],
      }),
    ]);
    const requestRefresh = vi.fn();

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    await resolver.resolveAccount("acme", "widgets");

    expect(requestRefresh).not.toHaveBeenCalled();
  });

  it("does not retry resolveAccountForRepo when no candidates were refreshed", async () => {
    resolveAccountForRepoMock.mockResolvedValueOnce(null);
    listAccountsMock.mockResolvedValueOnce([]);
    const requestRefresh = vi.fn();

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    const result = await resolver.resolveAccount("acme", "widgets");

    expect(result).toBeNull();
    expect(resolveAccountForRepoMock).toHaveBeenCalledTimes(1);
  });

  it("uses the only active account installed on the repo owner as a fallback account", async () => {
    const account = makeAccount({
      id: "acc-work",
      login: "work-user",
      installations: [
        {
          id: 7,
          account: { login: "acme", type: "Organization", avatarUrl: null },
          repositorySelection: "selected",
          repoFullNames: ["acme/legacy"],
        },
      ],
    });
    listAccountsMock.mockResolvedValueOnce([
      makeAccount({ id: "acc-personal", login: "personal-user" }),
      account,
    ]);
    const requestRefresh = vi.fn();

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    const result = await resolver.resolveFallbackAccount("acme");

    expect(result).toBe(account);
  });

  it("does not pick a fallback account when multiple active accounts are installed on the repo owner", async () => {
    listAccountsMock.mockResolvedValueOnce([
      makeAccount({
        id: "acc-a",
        login: "user-a",
        installations: [
          {
            id: 7,
            account: { login: "acme", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
            repoFullNames: ["acme/legacy"],
          },
        ],
      }),
      makeAccount({
        id: "acc-b",
        login: "user-b",
        installations: [
          {
            id: 8,
            account: { login: "ACME", type: "Organization", avatarUrl: null },
            repositorySelection: "all",
            repoFullNames: null,
          },
        ],
      }),
    ]);
    const requestRefresh = vi.fn();

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    const result = await resolver.resolveFallbackAccount("acme");

    expect(result).toBeNull();
  });

  it("still re-resolves and returns null when a refresh succeeds but does not heal coverage", async () => {
    resolveAccountForRepoMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    listAccountsMock.mockResolvedValueOnce([
      makeAccount({
        id: "acc-stale",
        installations: [
          {
            id: 7,
            account: { login: "acme", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
            repoFullNames: [],
          },
        ],
      }),
    ]);
    const requestRefresh = vi.fn().mockResolvedValue(true);

    const resolver = createSelfHealingAccountResolver({ requestRefresh });
    const result = await resolver.resolveAccount("acme", "widgets");

    expect(result).toBeNull();
    expect(resolveAccountForRepoMock).toHaveBeenCalledTimes(2);
  });
});
