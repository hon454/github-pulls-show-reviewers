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
