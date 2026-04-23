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
    browser: {
      storage: {
        local: { get, set, remove },
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
  it("returns an empty v4 settings shape when storage is empty", async () => {
    const { getSettings } = await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({
      version: 4,
      accountIds: [],
    });
  });

  it("overwrites legacy tokenEntries payloads with an empty v4 shape", async () => {
    browserMock.browser.storage.local.get.mockResolvedValueOnce({
      settings: {
        tokenEntries: [
          { id: "x", scope: "hon454/*", token: "ghp_legacy", label: null },
        ],
      },
    });
    const { getSettings } = await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({
      version: 4,
      accountIds: [],
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
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    });
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].login).toBe("hon454");
    expect(browserMock.browser.storage.local.set).toHaveBeenCalledWith({
      settings: { version: 4, accountIds: ["acc-1"] },
      "account:profile:acc-1": expect.objectContaining({
        id: "acc-1",
        login: "hon454",
      }),
      "account:auth:acc-1": expect.objectContaining({
        token: "ghu_abc",
      }),
      "account:installations:acc-1": expect.objectContaining({
        installations: [],
      }),
    });
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
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
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
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
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
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    });
    await markAccountInvalidated("acc-1", "revoked");
    const [account] = await listAccounts();
    expect(account.invalidated).toBe(true);
    expect(account.invalidatedReason).toBe("revoked");
  });

  it("markAccountInvalidated warns and skips when the stored auth record is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { markAccountInvalidated } = await import(
      "../src/storage/accounts"
    );
    await markAccountInvalidated("missing-acc", "revoked");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("missing-acc");
    expect(warnSpy.mock.calls[0][0]).toContain("markAccountInvalidated");
    // Nothing should land in storage for a missing record.
    const stored = await browser.storage.local.get();
    expect(Object.keys(stored)).not.toContain("account:auth:missing-acc");
  });

  it("updateAccountTokens warns and skips when the stored auth record is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { updateAccountTokens } = await import("../src/storage/accounts");
    await updateAccountTokens("missing-acc", {
      token: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: null,
      refreshTokenExpiresAt: null,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("updateAccountTokens");
    const stored = await browser.storage.local.get();
    expect(Object.keys(stored)).not.toContain("account:auth:missing-acc");
  });

  it("replaceInstallations warns and skips when the stored installations record is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { replaceInstallations } = await import("../src/storage/accounts");
    await replaceInstallations("missing-acc", []);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("replaceInstallations");
    const stored = await browser.storage.local.get();
    expect(Object.keys(stored)).not.toContain(
      "account:installations:missing-acc",
    );
  });

  it("upsertAccountByLogin replaces an existing invalidated account when login matches", async () => {
    const { addAccount, upsertAccountByLogin, listAccounts } = await import(
      "../src/storage/accounts"
    );

    await addAccount({
      id: "acc-original",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_old",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: true,
      invalidatedReason: "revoked",
      refreshToken: "ghr_old",
      expiresAt: 100,
      refreshTokenExpiresAt: 200,
    });

    const result = await upsertAccountByLogin({
      login: "hon454",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      token: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: 999,
      refreshTokenExpiresAt: 9999,
      installations: [
        {
          id: 42,
          account: { login: "hon454", type: "User", avatarUrl: null },
          repositorySelection: "all",
          repoFullNames: null,
        },
      ],
      newAccountId: "acc-should-be-ignored",
      now: 500,
    });

    // Same id + same createdAt; token/refresh refreshed; invalidated cleared.
    expect(result.id).toBe("acc-original");
    expect(result.createdAt).toBe(1);
    expect(result.token).toBe("ghu_new");
    expect(result.refreshToken).toBe("ghr_new");
    expect(result.invalidated).toBe(false);
    expect(result.invalidatedReason).toBeNull();
    expect(result.installations).toHaveLength(1);
    expect(result.installationsRefreshedAt).toBe(500);

    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("acc-original");
  });

  it("upsertAccountByLogin is case-insensitive on login", async () => {
    const { addAccount, upsertAccountByLogin, listAccounts } = await import(
      "../src/storage/accounts"
    );

    await addAccount({
      id: "acc-mixed",
      login: "Hon454",
      avatarUrl: null,
      token: "ghu_old",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    });

    const result = await upsertAccountByLogin({
      login: "hon454",
      avatarUrl: null,
      token: "ghu_new",
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
      installations: [],
      newAccountId: "acc-should-be-ignored",
      now: 500,
    });

    expect(result.id).toBe("acc-mixed");
    // Login casing updates to what GitHub returned.
    expect(result.login).toBe("hon454");

    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("acc-mixed");
  });

  it("upsertAccountByLogin appends when login is new", async () => {
    const { addAccount, upsertAccountByLogin, listAccounts } = await import(
      "../src/storage/accounts"
    );

    await addAccount({
      id: "acc-existing",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_existing",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    });

    const result = await upsertAccountByLogin({
      login: "another-user",
      avatarUrl: null,
      token: "ghu_new",
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
      installations: [],
      newAccountId: "acc-new",
      now: 500,
    });

    expect(result.id).toBe("acc-new");
    expect(result.login).toBe("another-user");

    const accounts = await listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.id).sort()).toEqual(
      ["acc-existing", "acc-new"].sort(),
    );
  });

  it("upsertAccountByLogin collapses duplicate matching logins into one record", async () => {
    const { addAccount, upsertAccountByLogin, listAccounts } = await import(
      "../src/storage/accounts"
    );

    await addAccount({
      id: "acc-original",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_old_1",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: true,
      invalidatedReason: "revoked",
      refreshToken: "ghr_old_1",
      expiresAt: 100,
      refreshTokenExpiresAt: 200,
    });
    await addAccount({
      id: "acc-ghost",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_old_2",
      createdAt: 2,
      installations: [],
      installationsRefreshedAt: 2,
      invalidated: false,
      invalidatedReason: null,
      refreshToken: "ghr_old_2",
      expiresAt: 101,
      refreshTokenExpiresAt: 201,
    });

    const result = await upsertAccountByLogin({
      login: "hon454",
      avatarUrl: null,
      token: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: 999,
      refreshTokenExpiresAt: 9999,
      installations: [],
      newAccountId: "acc-should-be-ignored",
      now: 500,
    });

    expect(result.id).toBe("acc-original");

    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("acc-original");
    expect(accounts[0].token).toBe("ghu_new");
  });

  it("rejects malformed account payloads at read time by resetting to empty", async () => {
    browserMock.browser.storage.local.get.mockResolvedValueOnce({
      settings: {
        version: 4,
        accounts: [{ id: 123, login: 456 }],
      },
    });
    const { getSettings } = await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({
      version: 4,
      accountIds: [],
    });
  });
});

describe("resolveAccountForRepo", () => {
  async function seedAccounts(accounts: unknown[]) {
    const storage = Object.fromEntries(
      accounts.flatMap((account) => {
        const typed = account as {
          id: string;
          login: string;
          avatarUrl: string | null;
          token: string;
          createdAt: number;
          installations: unknown[];
          installationsRefreshedAt: number;
          invalidated: boolean;
          invalidatedReason: string | null;
          refreshToken: string | null;
          expiresAt: number | null;
          refreshTokenExpiresAt: number | null;
        };
        return [
          [
            `account:profile:${typed.id}`,
            {
              id: typed.id,
              login: typed.login,
              avatarUrl: typed.avatarUrl,
              createdAt: typed.createdAt,
            },
          ],
          [
            `account:auth:${typed.id}`,
            {
              token: typed.token,
              invalidated: typed.invalidated,
              invalidatedReason: typed.invalidatedReason,
              refreshToken: typed.refreshToken,
              expiresAt: typed.expiresAt,
              refreshTokenExpiresAt: typed.refreshTokenExpiresAt,
            },
          ],
          [
            `account:installations:${typed.id}`,
            {
              installations: typed.installations,
              installationsRefreshedAt: typed.installationsRefreshedAt,
            },
          ],
        ];
      }),
    );
    browserMock.browser.storage.local.get.mockImplementation(
      async (key?: string | string[] | Record<string, unknown>) => {
        if (typeof key === "string") {
          if (key === "settings") {
            return {
              settings: {
                version: 4,
                accountIds: accounts.map((account) => (account as { id: string }).id),
              },
            };
          }
          return key in storage ? { [key]: storage[key] } : {};
        }
        if (Array.isArray(key)) {
          return Object.fromEntries(
            key
              .filter((entry) =>
                entry === "settings" || entry in storage,
              )
              .map((entry) =>
                entry === "settings"
                  ? [
                      "settings",
                      {
                        version: 4,
                        accountIds: accounts.map((account) => (account as { id: string }).id),
                      },
                    ]
                  : [entry, storage[entry]],
              ),
          );
        }
        return {
          settings: {
            version: 4,
            accountIds: accounts.map((account) => (account as { id: string }).id),
          },
          ...storage,
        };
      },
    );
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
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
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
