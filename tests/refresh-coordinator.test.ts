import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as authModule from "../src/github/auth";
import {
  RefreshTokenError,
  type RefreshTokenResult,
} from "../src/github/auth";
import { createRefreshCoordinator } from "../src/auth/refresh-coordinator";
import type { Account } from "../src/storage/accounts";

type AuthModule = typeof authModule;

const listAccountsMock = vi.hoisted(() => vi.fn());
const updateAccountTokensMock = vi.hoisted(() => vi.fn());
const markAccountInvalidatedMock = vi.hoisted(() => vi.fn());
const refreshAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../src/storage/accounts", () => ({
  listAccounts: listAccountsMock,
  updateAccountTokens: updateAccountTokensMock,
  markAccountInvalidated: markAccountInvalidatedMock,
}));

vi.mock("../src/github/auth", async () => {
  const actual = await vi.importActual<AuthModule>("../src/github/auth");
  return {
    ...actual,
    refreshAccessToken: refreshAccessTokenMock,
  };
});

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
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
    expiresAt: null,
    refreshTokenExpiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  listAccountsMock.mockReset();
  updateAccountTokensMock.mockReset().mockResolvedValue(undefined);
  markAccountInvalidatedMock.mockReset().mockResolvedValue(undefined);
  refreshAccessTokenMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRefreshCoordinator", () => {
  it("refreshes, updates storage, and returns the new token on success", async () => {
    listAccountsMock.mockResolvedValue([makeAccount()]);
    const fresh: RefreshTokenResult = {
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: 1234,
      refreshTokenExpiresAt: 5678,
    };
    refreshAccessTokenMock.mockResolvedValue(fresh);

    const coordinator = createRefreshCoordinator({ getClientId: () => "Iv1.test" });
    const outcome = await coordinator.refreshAccountToken("acc-1");

    expect(outcome).toEqual({ ok: true, token: "ghu_new" });
    expect(updateAccountTokensMock).toHaveBeenCalledWith("acc-1", {
      token: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: 1234,
      refreshTokenExpiresAt: 5678,
    });
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("dedupes concurrent calls for the same account into a single refresh", async () => {
    listAccountsMock.mockResolvedValue([makeAccount()]);
    let resolveRefresh: (value: RefreshTokenResult) => void = () => {};
    refreshAccessTokenMock.mockImplementation(
      () =>
        new Promise<RefreshTokenResult>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const coordinator = createRefreshCoordinator({ getClientId: () => "Iv1.test" });
    const a = coordinator.refreshAccountToken("acc-1");
    const b = coordinator.refreshAccountToken("acc-1");

    // Flush microtasks so listAccounts resolves and refreshAccessToken is called,
    // which populates resolveRefresh before we invoke it.
    await Promise.resolve();
    await Promise.resolve();

    resolveRefresh({
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: null,
      refreshTokenExpiresAt: null,
    });

    const [outcomeA, outcomeB] = await Promise.all([a, b]);
    expect(outcomeA).toEqual({ ok: true, token: "ghu_new" });
    expect(outcomeB).toEqual({ ok: true, token: "ghu_new" });
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(updateAccountTokensMock).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh refresh after the previous one settles", async () => {
    listAccountsMock.mockResolvedValue([makeAccount()]);
    refreshAccessTokenMock.mockResolvedValue({
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
      expiresAt: null,
      refreshTokenExpiresAt: null,
    });

    const coordinator = createRefreshCoordinator({ getClientId: () => "Iv1.test" });
    await coordinator.refreshAccountToken("acc-1");
    await coordinator.refreshAccountToken("acc-1");

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
  });

  it("marks the account invalidated with refresh_failed on a terminal error", async () => {
    listAccountsMock.mockResolvedValue([makeAccount()]);
    refreshAccessTokenMock.mockRejectedValue(
      new RefreshTokenError("terminal", "bad_refresh_token"),
    );

    const coordinator = createRefreshCoordinator({ getClientId: () => "Iv1.test" });
    const outcome = await coordinator.refreshAccountToken("acc-1");

    expect(outcome).toEqual({ ok: false, terminal: true });
    expect(markAccountInvalidatedMock).toHaveBeenCalledWith(
      "acc-1",
      "refresh_failed",
    );
    expect(updateAccountTokensMock).not.toHaveBeenCalled();
  });

  it("does NOT invalidate on a transient error", async () => {
    listAccountsMock.mockResolvedValue([makeAccount()]);
    refreshAccessTokenMock.mockRejectedValue(
      new RefreshTokenError("transient", "network_error"),
    );

    const coordinator = createRefreshCoordinator({ getClientId: () => "Iv1.test" });
    const outcome = await coordinator.refreshAccountToken("acc-1");

    expect(outcome).toEqual({ ok: false, terminal: false });
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
    expect(updateAccountTokensMock).not.toHaveBeenCalled();
  });

  it("returns terminal=true without calling refresh when the account has no refresh token", async () => {
    listAccountsMock.mockResolvedValue([makeAccount({ refreshToken: null })]);

    const coordinator = createRefreshCoordinator({ getClientId: () => "Iv1.test" });
    const outcome = await coordinator.refreshAccountToken("acc-1");

    expect(outcome).toEqual({ ok: false, terminal: true });
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("returns terminal=true when the account does not exist", async () => {
    listAccountsMock.mockResolvedValue([]);

    const coordinator = createRefreshCoordinator({ getClientId: () => "Iv1.test" });
    const outcome = await coordinator.refreshAccountToken("missing");

    expect(outcome).toEqual({ ok: false, terminal: true });
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });
});
