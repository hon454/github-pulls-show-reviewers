import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StorageShape = Record<string, unknown>;

function createBrowserMock() {
  let storage: StorageShape = {};
  const get = vi.fn(async (key?: string) => {
    if (typeof key === "string") {
      return key in storage ? { [key]: storage[key] } : {};
    }
    return { ...storage };
  });
  const set = vi.fn(async (items: StorageShape) => {
    storage = { ...storage, ...items };
  });
  return {
    browser: { storage: { local: { get, set } } },
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

describe("settings migration v2 -> v3", () => {
  it("rewrites a v2 settings shape to v3 with null token-lifetime fields", async () => {
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

    expect(settings.version).toBe(3);
    expect(settings.accounts).toHaveLength(1);
    expect(settings.accounts[0]).toMatchObject({
      id: "acc-1",
      token: "ghu_old",
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    });

    expect(browserMock.snapshot().settings).toMatchObject({ version: 3 });
  });

  it("returns an empty v3 settings shape when storage is empty", async () => {
    const { getSettings } = await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({ version: 3, accounts: [] });
  });

  it("loads a v3 shape unchanged", async () => {
    browserMock.seed({
      version: 3,
      accounts: [
        {
          id: "acc-1",
          login: "hon454",
          avatarUrl: null,
          token: "ghu_x",
          createdAt: 1,
          installations: [],
          installationsRefreshedAt: 1,
          invalidated: false,
          invalidatedReason: null,
          refreshToken: "ghr_x",
          expiresAt: 1234,
          refreshTokenExpiresAt: 5678,
        },
      ],
    });

    const { getSettings } = await import("../src/storage/accounts");
    const settings = await getSettings();
    expect(settings.version).toBe(3);
    expect(settings.accounts[0].refreshToken).toBe("ghr_x");
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
});
