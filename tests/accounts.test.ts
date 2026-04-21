import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StorageShape = Record<string, unknown>;

function createBrowserMock() {
  let storage: StorageShape = {};
  const get = vi.fn(async (key?: string | string[] | Record<string, unknown>) => {
    if (typeof key === "string") {
      return key in storage ? { [key]: storage[key] } : {};
    }
    return { ...storage };
  });
  const set = vi.fn(async (items: StorageShape) => {
    storage = { ...storage, ...items };
  });
  return {
    browser: {
      storage: {
        local: { get, set },
      },
    },
    reset() {
      storage = {};
      get.mockClear();
      set.mockClear();
    },
  };
}

let browserMock: ReturnType<typeof createBrowserMock>;

beforeEach(() => {
  browserMock = createBrowserMock();
  vi.stubGlobal("browser", browserMock.browser);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("accounts storage", () => {
  it("returns an empty v2 settings shape when storage is empty", async () => {
    const { getSettings } = await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({
      version: 2,
      accounts: [],
    });
  });

  it("overwrites legacy tokenEntries payloads with an empty v2 shape", async () => {
    browserMock.browser.storage.local.get.mockResolvedValueOnce({
      settings: {
        tokenEntries: [
          { id: "x", scope: "hon454/*", token: "ghp_legacy", label: null },
        ],
      },
    });
    const { getSettings } = await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({
      version: 2,
      accounts: [],
    });
  });

  it("addAccount persists and listAccounts returns the account", async () => {
    const { addAccount, listAccounts } = await import("../src/storage/accounts");
    await addAccount({
      id: "acc-1",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_abc",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
    });
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].login).toBe("hon454");
  });

  it("removeAccount drops the matching id", async () => {
    const { addAccount, removeAccount, listAccounts } = await import(
      "../src/storage/accounts"
    );
    await addAccount({
      id: "acc-1",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_abc",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
    });
    await removeAccount("acc-1");
    await expect(listAccounts()).resolves.toEqual([]);
  });

  it("replaceInstallations swaps installations and bumps refreshedAt", async () => {
    const { addAccount, replaceInstallations, listAccounts } = await import(
      "../src/storage/accounts"
    );
    await addAccount({
      id: "acc-1",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_abc",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
    });
    await replaceInstallations("acc-1", [
      {
        id: 42,
        account: { login: "hon454", type: "User", avatarUrl: null },
        repositorySelection: "all",
        repoFullNames: null,
      },
    ]);
    const [account] = await listAccounts();
    expect(account.installations).toHaveLength(1);
    expect(account.installations[0].id).toBe(42);
    expect(account.installationsRefreshedAt).toBeGreaterThan(1);
  });

  it("markAccountInvalidated sets the invalidation fields", async () => {
    const { addAccount, markAccountInvalidated, listAccounts } = await import(
      "../src/storage/accounts"
    );
    await addAccount({
      id: "acc-1",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_abc",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
    });
    await markAccountInvalidated("acc-1", "revoked");
    const [account] = await listAccounts();
    expect(account.invalidated).toBe(true);
    expect(account.invalidatedReason).toBe("revoked");
  });

  it("rejects malformed account payloads at read time by resetting to empty", async () => {
    browserMock.browser.storage.local.get.mockResolvedValueOnce({
      settings: {
        version: 2,
        accounts: [{ id: 123, login: 456 }],
      },
    });
    const { getSettings } = await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({
      version: 2,
      accounts: [],
    });
  });
});

describe("resolveAccountForRepo", () => {
  async function seedAccounts(accounts: unknown[]) {
    browserMock.browser.storage.local.get.mockResolvedValue({
      settings: { version: 2, accounts },
    });
  }

  function makeAccount(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "acc",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_abc",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
      ...overrides,
    };
  }

  it("returns null when no account has a matching installation", async () => {
    await seedAccounts([makeAccount()]);
    const { resolveAccountForRepo } = await import("../src/storage/accounts");
    await expect(
      resolveAccountForRepo("cinev", "shotloom"),
    ).resolves.toBeNull();
  });

  it("matches via an all-repos installation on the same owner", async () => {
    await seedAccounts([
      makeAccount({
        installations: [
          {
            id: 1,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "all",
            repoFullNames: null,
          },
        ],
      }),
    ]);
    const { resolveAccountForRepo } = await import("../src/storage/accounts");
    const account = await resolveAccountForRepo("cinev", "shotloom");
    expect(account?.login).toBe("hon454");
  });

  it("matches selected installations by full name case-insensitively", async () => {
    await seedAccounts([
      makeAccount({
        installations: [
          {
            id: 1,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
            repoFullNames: ["CINEV/Shotloom"],
          },
        ],
      }),
    ]);
    const { resolveAccountForRepo } = await import("../src/storage/accounts");
    const account = await resolveAccountForRepo("cinev", "shotloom");
    expect(account).not.toBeNull();
  });

  it("does not match selected installations when repo is absent", async () => {
    await seedAccounts([
      makeAccount({
        installations: [
          {
            id: 1,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
            repoFullNames: ["cinev/landing"],
          },
        ],
      }),
    ]);
    const { resolveAccountForRepo } = await import("../src/storage/accounts");
    await expect(
      resolveAccountForRepo("cinev", "shotloom"),
    ).resolves.toBeNull();
  });

  it("skips invalidated accounts", async () => {
    await seedAccounts([
      makeAccount({
        invalidated: true,
        invalidatedReason: "revoked",
        installations: [
          {
            id: 1,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "all",
            repoFullNames: null,
          },
        ],
      }),
    ]);
    const { resolveAccountForRepo } = await import("../src/storage/accounts");
    await expect(
      resolveAccountForRepo("cinev", "shotloom"),
    ).resolves.toBeNull();
  });

  it("returns the earliest matching account when multiple accounts match", async () => {
    await seedAccounts([
      makeAccount({
        id: "later",
        login: "hon454-work",
        createdAt: 10,
        installations: [
          {
            id: 2,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "all",
            repoFullNames: null,
          },
        ],
      }),
      makeAccount({
        id: "earlier",
        login: "hon454",
        createdAt: 1,
        installations: [
          {
            id: 1,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "all",
            repoFullNames: null,
          },
        ],
      }),
    ]);
    const { resolveAccountForRepo } = await import("../src/storage/accounts");
    const account = await resolveAccountForRepo("cinev", "shotloom");
    expect(account?.id).toBe("earlier");
  });
});
