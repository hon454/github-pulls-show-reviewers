import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StorageShape = Record<string, unknown>;

function createBrowserMock() {
  let storage: StorageShape = {};
  const get = vi.fn(async (key?: string | string[] | Record<string, unknown>) => {
    if (typeof key === "string") {
      return key in storage ? { [key]: storage[key] } : {};
    }
    if (Array.isArray(key)) {
      return Object.fromEntries(
        key.filter((entry) => entry in storage).map((entry) => [entry, storage[entry]]),
      );
    }
    return { ...storage };
  });
  const set = vi.fn(async (items: StorageShape) => {
    storage = { ...storage, ...items };
  });
  const remove = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete storage[key];
    }
  });
  return {
    browser: { storage: { local: { get, set, remove } } },
    snapshot: () => ({ ...storage }),
    seed(value: unknown) {
      storage = { settings: value };
    },
  };
}

let browserMock: ReturnType<typeof createBrowserMock>;

beforeEach(() => {
  vi.resetModules();
  browserMock = createBrowserMock();
  vi.stubGlobal("browser", browserMock.browser);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings migration", () => {
  it("rewrites a v2 settings shape to v4 with a per-account storage entry", async () => {
    browserMock.seed({
      version: 2,
      accounts: [
        {
          id: "acc-1",
          login: "hon454",
          avatarUrl: null,
          token: "ghu_old",
          createdAt: 1,
          installations: [],
          installationsRefreshedAt: 1,
          invalidated: false,
          invalidatedReason: null,
        },
      ],
    });

    const { getSettings } = await import("../src/storage/accounts");
    const settings = await getSettings();

    expect(settings).toEqual({ version: 4, accountIds: ["acc-1"] });
    expect(browserMock.snapshot()).toMatchObject({
      settings: { version: 4, accountIds: ["acc-1"] },
      "account:profile:acc-1": {
        id: "acc-1",
        login: "hon454",
      },
      "account:auth:acc-1": {
        token: "ghu_old",
        refreshToken: null,
        expiresAt: null,
        refreshTokenExpiresAt: null,
      },
      "account:installations:acc-1": {
        installations: [],
      },
    });
  });

  it("returns an empty v4 settings shape when storage is empty", async () => {
    const { getSettings } = await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({ version: 4, accountIds: [] });
  });

  it("loads a v4 shape unchanged", async () => {
    browserMock.seed({
      version: 4,
      accountIds: ["acc-1"],
    });
    await browserMock.browser.storage.local.set({
      "account:profile:acc-1": {
        id: "acc-1",
        login: "hon454",
        avatarUrl: null,
        createdAt: 1,
      },
      "account:auth:acc-1": {
        token: "ghu_x",
        invalidated: false,
        invalidatedReason: null,
        refreshToken: "ghr_x",
        expiresAt: 1234,
        refreshTokenExpiresAt: 5678,
      },
      "account:installations:acc-1": {
        installations: [],
        installationsRefreshedAt: 1,
      },
    });

    const { getSettings, listAccounts } = await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({ version: 4, accountIds: ["acc-1"] });
    const [account] = await listAccounts();
    expect(account.refreshToken).toBe("ghr_x");
  });
});

describe("updateAccountTokens", () => {
  it("replaces the four token fields without touching invalidation state", async () => {
    const { addAccount, updateAccountTokens, listAccounts } = await import(
      "../src/storage/accounts"
    );

    await addAccount({
      id: "acc-1",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_old",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
      refreshToken: "ghr_old",
      expiresAt: 100,
      refreshTokenExpiresAt: 200,
    });

    await updateAccountTokens("acc-1", {
      token: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: 999,
      refreshTokenExpiresAt: 1999,
    });

    const [account] = await listAccounts();
    expect(account).toMatchObject({
      token: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: 999,
      refreshTokenExpiresAt: 1999,
      invalidated: false,
      invalidatedReason: null,
    });
  });

  it("updates only the targeted account key", async () => {
    const { addAccount, updateAccountTokens } = await import("../src/storage/accounts");

    await addAccount({
      id: "acc-1",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_old_1",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
      refreshToken: "ghr_old_1",
      expiresAt: 100,
      refreshTokenExpiresAt: 200,
    });
    await addAccount({
      id: "acc-2",
      login: "hon454-work",
      avatarUrl: null,
      token: "ghu_old_2",
      createdAt: 2,
      installations: [],
      installationsRefreshedAt: 2,
      invalidated: false,
      invalidatedReason: null,
      refreshToken: "ghr_old_2",
      expiresAt: 300,
      refreshTokenExpiresAt: 400,
    });

    await updateAccountTokens("acc-1", {
      token: "ghu_new_1",
      refreshToken: "ghr_new_1",
      expiresAt: 999,
      refreshTokenExpiresAt: 1999,
    });

    expect(browserMock.snapshot()).toMatchObject({
      "account:auth:acc-1": {
        token: "ghu_new_1",
        refreshToken: "ghr_new_1",
      },
      "account:auth:acc-2": {
        token: "ghu_old_2",
        refreshToken: "ghr_old_2",
      },
    });
  });
});
