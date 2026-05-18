import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as authModule from "../src/github/auth";
import { createInstallationRefreshService } from "../src/background/installation-refresh";
import type { Account, Installation } from "../src/storage/accounts";

type AuthModule = typeof authModule;

const getAccountByIdMock = vi.hoisted(() => vi.fn());
const replaceInstallationsMock = vi.hoisted(() => vi.fn());
const markAccountInvalidatedMock = vi.hoisted(() => vi.fn());
const refreshAccountTokenMock = vi.hoisted(() => vi.fn());
const fetchUserInstallationsMock = vi.hoisted(() => vi.fn());
const fetchInstallationRepositoriesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/storage/accounts", () => ({
  getAccountById: getAccountByIdMock,
  replaceInstallations: replaceInstallationsMock,
  markAccountInvalidated: markAccountInvalidatedMock,
}));

vi.mock("../src/github/auth", async () => {
  const actual = await vi.importActual<AuthModule>("../src/github/auth");
  return {
    ...actual,
    fetchUserInstallations: fetchUserInstallationsMock,
    fetchInstallationRepositories: fetchInstallationRepositoriesMock,
  };
});

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    login: "octocat",
    avatarUrl: null,
    token: "ghu_old",
    createdAt: 1,
    installations: [],
    installationsRefreshedAt: 1,
    invalidated: false,
    invalidatedReason: null,
    refreshToken: "ghr_old",
    expiresAt: null,
    refreshTokenExpiresAt: null,
    ...overrides,
  };
}

function makeApiInstallation(overrides: {
  id: number;
  login: string;
  repositorySelection: "all" | "selected";
}): {
  id: number;
  account: { login: string; type: "User" | "Organization"; avatarUrl: string | null };
  repositorySelection: "all" | "selected";
} {
  return {
    id: overrides.id,
    account: {
      login: overrides.login,
      type: "Organization",
      avatarUrl: null,
    },
    repositorySelection: overrides.repositorySelection,
  };
}

const refreshCoordinatorMock = {
  refreshAccountToken: refreshAccountTokenMock,
};

beforeEach(() => {
  getAccountByIdMock.mockReset();
  replaceInstallationsMock.mockReset().mockResolvedValue(undefined);
  markAccountInvalidatedMock.mockReset().mockResolvedValue(undefined);
  refreshAccountTokenMock.mockReset();
  fetchUserInstallationsMock.mockReset();
  fetchInstallationRepositoriesMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createInstallationRefreshService", () => {
  it("fetches installations + selected-repo lists with the account token and persists them", async () => {
    getAccountByIdMock.mockResolvedValue(makeAccount({ token: "ghu_live" }));
    fetchUserInstallationsMock.mockResolvedValue({
      items: [
        makeApiInstallation({ id: 1, login: "acme", repositorySelection: "selected" }),
        makeApiInstallation({ id: 2, login: "octocat", repositorySelection: "all" }),
      ],
      truncated: false,
    });
    fetchInstallationRepositoriesMock.mockResolvedValue({
      items: ["acme/widgets", "acme/legacy"],
      truncated: false,
    });

    const service = createInstallationRefreshService({
      refreshCoordinator: refreshCoordinatorMock,
    });
    const outcome = await service.refreshAccountInstallations("acc-1");

    expect(outcome).toEqual({ ok: true });
    expect(fetchUserInstallationsMock).toHaveBeenCalledWith({ token: "ghu_live" });
    expect(fetchInstallationRepositoriesMock).toHaveBeenCalledTimes(1);
    expect(fetchInstallationRepositoriesMock).toHaveBeenCalledWith({
      token: "ghu_live",
      installationId: 1,
    });

    expect(replaceInstallationsMock).toHaveBeenCalledTimes(1);
    const [accountId, installations] = replaceInstallationsMock.mock.calls[0] as [
      string,
      Installation[],
    ];
    expect(accountId).toBe("acc-1");
    expect(installations).toEqual([
      {
        id: 1,
        account: { login: "acme", type: "Organization", avatarUrl: null },
        repositorySelection: "selected",
        repoSnapshot: {
          fullNames: ["acme/widgets", "acme/legacy"],
          completeness: "complete",
        },
      },
      {
        id: 2,
        account: { login: "octocat", type: "Organization", avatarUrl: null },
        repositorySelection: "all",
        repoSnapshot: null,
      },
    ]);
  });

  it("persists truncated selected-repository snapshots", async () => {
    getAccountByIdMock.mockResolvedValue(makeAccount({ token: "ghu_live" }));
    fetchUserInstallationsMock.mockResolvedValue({
      items: [
        makeApiInstallation({ id: 1, login: "acme", repositorySelection: "selected" }),
      ],
      truncated: false,
    });
    fetchInstallationRepositoriesMock.mockResolvedValue({
      items: ["acme/widgets"],
      truncated: true,
    });

    const service = createInstallationRefreshService({
      refreshCoordinator: refreshCoordinatorMock,
    });
    const outcome = await service.refreshAccountInstallations("acc-1");

    expect(outcome).toEqual({ ok: true });
    const [, installations] = replaceInstallationsMock.mock.calls[0] as [
      string,
      Installation[],
    ];
    expect(installations).toEqual([
      {
        id: 1,
        account: { login: "acme", type: "Organization", avatarUrl: null },
        repositorySelection: "selected",
        repoSnapshot: {
          fullNames: ["acme/widgets"],
          completeness: "truncated",
        },
      },
    ]);
  });

  it("does not persist when the account installation list is truncated", async () => {
    getAccountByIdMock.mockResolvedValue(makeAccount({ token: "ghu_live" }));
    fetchUserInstallationsMock.mockResolvedValue({
      items: [
        makeApiInstallation({ id: 1, login: "acme", repositorySelection: "all" }),
      ],
      truncated: true,
    });

    const service = createInstallationRefreshService({
      refreshCoordinator: refreshCoordinatorMock,
    });
    const outcome = await service.refreshAccountInstallations("acc-1");

    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(fetchInstallationRepositoriesMock).not.toHaveBeenCalled();
    expect(replaceInstallationsMock).not.toHaveBeenCalled();
  });

  it("returns ok:false reason=no-account when the account has been removed", async () => {
    getAccountByIdMock.mockResolvedValue(null);

    const service = createInstallationRefreshService({
      refreshCoordinator: refreshCoordinatorMock,
    });
    const outcome = await service.refreshAccountInstallations("missing");

    expect(outcome).toEqual({ ok: false, reason: "no-account" });
    expect(fetchUserInstallationsMock).not.toHaveBeenCalled();
    expect(replaceInstallationsMock).not.toHaveBeenCalled();
  });

  it("returns ok:false reason=invalidated for an invalidated account without trying to fetch", async () => {
    getAccountByIdMock.mockResolvedValue(
      makeAccount({ invalidated: true, invalidatedReason: "revoked" }),
    );

    const service = createInstallationRefreshService({
      refreshCoordinator: refreshCoordinatorMock,
    });
    const outcome = await service.refreshAccountInstallations("acc-1");

    expect(outcome).toEqual({ ok: false, reason: "invalidated" });
    expect(fetchUserInstallationsMock).not.toHaveBeenCalled();
    expect(replaceInstallationsMock).not.toHaveBeenCalled();
  });

  it("refreshes the access token on a 401 and retries the fetch with the new token", async () => {
    getAccountByIdMock
      .mockResolvedValueOnce(makeAccount({ token: "ghu_old" }))
      .mockResolvedValueOnce(makeAccount({ token: "ghu_new" }));
    fetchUserInstallationsMock
      .mockRejectedValueOnce(Object.assign(new Error("401"), { status: 401 }))
      .mockResolvedValueOnce({
        items: [
          makeApiInstallation({ id: 7, login: "acme", repositorySelection: "all" }),
        ],
        truncated: false,
      });
    refreshAccountTokenMock.mockResolvedValue({ ok: true, token: "ghu_new" });

    const service = createInstallationRefreshService({
      refreshCoordinator: refreshCoordinatorMock,
    });
    const outcome = await service.refreshAccountInstallations("acc-1");

    expect(outcome).toEqual({ ok: true });
    expect(fetchUserInstallationsMock).toHaveBeenCalledTimes(2);
    expect(fetchUserInstallationsMock.mock.calls[0][0]).toEqual({ token: "ghu_old" });
    expect(fetchUserInstallationsMock.mock.calls[1][0]).toEqual({ token: "ghu_new" });
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1");
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
    expect(replaceInstallationsMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates the account when the retry after token refresh still fails with 401", async () => {
    getAccountByIdMock.mockResolvedValue(makeAccount({ token: "ghu_old" }));
    fetchUserInstallationsMock.mockRejectedValue(
      Object.assign(new Error("401"), { status: 401 }),
    );
    refreshAccountTokenMock.mockResolvedValue({ ok: true, token: "ghu_new" });

    const service = createInstallationRefreshService({
      refreshCoordinator: refreshCoordinatorMock,
    });
    const outcome = await service.refreshAccountInstallations("acc-1");

    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(markAccountInvalidatedMock).toHaveBeenCalledWith("acc-1", "revoked");
    expect(replaceInstallationsMock).not.toHaveBeenCalled();
  });

  it("returns ok:false reason=failed without invalidation when token refresh is transiently unavailable", async () => {
    getAccountByIdMock.mockResolvedValue(makeAccount({ token: "ghu_old" }));
    fetchUserInstallationsMock.mockRejectedValue(
      Object.assign(new Error("401"), { status: 401 }),
    );
    refreshAccountTokenMock.mockResolvedValue({ ok: false, terminal: false });

    const service = createInstallationRefreshService({
      refreshCoordinator: refreshCoordinatorMock,
    });
    const outcome = await service.refreshAccountInstallations("acc-1");

    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
    expect(replaceInstallationsMock).not.toHaveBeenCalled();
  });

  it("returns ok:false reason=failed when the account has no refresh token and the initial fetch is unauthorized", async () => {
    getAccountByIdMock.mockResolvedValue(
      makeAccount({ refreshToken: null, token: "ghu_dead" }),
    );
    fetchUserInstallationsMock.mockRejectedValue(
      Object.assign(new Error("401"), { status: 401 }),
    );

    const service = createInstallationRefreshService({
      refreshCoordinator: refreshCoordinatorMock,
    });
    const outcome = await service.refreshAccountInstallations("acc-1");

    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
    expect(markAccountInvalidatedMock).toHaveBeenCalledWith("acc-1", "revoked");
  });

  it("returns ok:false reason=failed and does not persist when the API throws a non-401 error", async () => {
    getAccountByIdMock.mockResolvedValue(makeAccount());
    fetchUserInstallationsMock.mockRejectedValue(new Error("network down"));

    const service = createInstallationRefreshService({
      refreshCoordinator: refreshCoordinatorMock,
    });
    const outcome = await service.refreshAccountInstallations("acc-1");

    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
    expect(replaceInstallationsMock).not.toHaveBeenCalled();
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("dedupes concurrent refresh calls for the same account into a single API run", async () => {
    getAccountByIdMock.mockResolvedValue(makeAccount());
    let resolveFetch: (value: {
      items: ReturnType<typeof makeApiInstallation>[];
      truncated: boolean;
    }) => void = () => {};
    fetchUserInstallationsMock.mockImplementation(
      () =>
        new Promise<{
          items: ReturnType<typeof makeApiInstallation>[];
          truncated: boolean;
        }>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const service = createInstallationRefreshService({
      refreshCoordinator: refreshCoordinatorMock,
    });
    const a = service.refreshAccountInstallations("acc-1");
    const b = service.refreshAccountInstallations("acc-1");

    await Promise.resolve();
    await Promise.resolve();

    resolveFetch({
      items: [
        makeApiInstallation({ id: 9, login: "acme", repositorySelection: "all" }),
      ],
      truncated: false,
    });

    const [outcomeA, outcomeB] = await Promise.all([a, b]);

    expect(outcomeA).toEqual({ ok: true });
    expect(outcomeB).toEqual({ ok: true });
    expect(getAccountByIdMock).toHaveBeenCalledTimes(1);
    expect(fetchUserInstallationsMock).toHaveBeenCalledTimes(1);
    expect(replaceInstallationsMock).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh refresh for the same account after the previous one settles", async () => {
    getAccountByIdMock.mockResolvedValue(makeAccount());
    fetchUserInstallationsMock.mockResolvedValue({ items: [], truncated: false });

    const service = createInstallationRefreshService({
      refreshCoordinator: refreshCoordinatorMock,
    });
    await service.refreshAccountInstallations("acc-1");
    await service.refreshAccountInstallations("acc-1");

    expect(fetchUserInstallationsMock).toHaveBeenCalledTimes(2);
    expect(replaceInstallationsMock).toHaveBeenCalledTimes(2);
  });
});
