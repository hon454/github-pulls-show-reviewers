import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StorageShape = Record<string, unknown>;

function createBrowserMock() {
  let storage: StorageShape = {};
  const get = vi.fn(
    async (key?: string | string[] | Record<string, unknown>) => {
      if (typeof key === "string") {
        return key in storage ? { [key]: storage[key] } : {};
      }
      if (Array.isArray(key)) {
        return Object.fromEntries(
          key
            .filter((entry) => entry in storage)
            .map((entry) => [entry, storage[entry]]),
        );
      }
      return { ...storage };
    },
  );
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

    const { getSettings, accountMutations } =
      await import("../src/storage/accounts");
    await accountMutations.initialize();
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
    await expect(getSettings()).resolves.toEqual({
      version: 4,
      accountIds: [],
    });
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

    const { getSettings, listAccounts } =
      await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({
      version: 4,
      accountIds: ["acc-1"],
    });
    const [account] = await listAccounts();
    expect(account.refreshToken).toBe("ghr_x");
  });
});

describe("commitAuth token rotation", () => {
  const account = (id: string, login: string, generation: number) => ({
    id,
    login,
    avatarUrl: null,
    token: `ghu_old_${generation}`,
    createdAt: generation,
    installations: [],
    installationsRefreshedAt: generation,
    invalidated: false,
    invalidatedReason: null,
    refreshToken: `ghr_old_${generation}`,
    expiresAt: 100 * generation,
    refreshTokenExpiresAt: 200 * generation,
  });

  it("replaces the four token fields without touching invalidation state", async () => {
    browserMock.seed({ version: 3, accounts: [account("acc-1", "hon454", 1)] });
    const { accountMutations, credentialGeneration, listAccounts } =
      await import("../src/storage/accounts");
    const [stored] = await accountMutations.listAccounts();

    await accountMutations.commitAuth("acc-1", credentialGeneration(stored), {
      tokens: {
        token: "ghu_new",
        refreshToken: "ghr_new",
        expiresAt: 999,
        refreshTokenExpiresAt: 1999,
      },
    });

    const [rotated] = await listAccounts();
    expect(rotated).toMatchObject({
      token: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: 999,
      refreshTokenExpiresAt: 1999,
      invalidated: false,
      invalidatedReason: null,
    });
    expect(credentialGeneration(rotated)).not.toBe(
      credentialGeneration(stored),
    );
  });

  it("updates only the targeted account key", async () => {
    browserMock.seed({
      version: 3,
      accounts: [
        account("acc-1", "hon454", 1),
        account("acc-2", "hon454-work", 2),
      ],
    });
    const { accountMutations, credentialGeneration } =
      await import("../src/storage/accounts");
    const stored = await accountMutations.getAccountById("acc-1");

    await accountMutations.commitAuth("acc-1", credentialGeneration(stored!), {
      tokens: {
        token: "ghu_new_1",
        refreshToken: "ghr_new_1",
        expiresAt: 999,
        refreshTokenExpiresAt: 1999,
      },
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
