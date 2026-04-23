import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProactiveRefreshService,
  selectAccountsDueForRefresh,
  selectAccountsWithExpiredRefreshToken,
} from "../src/background/proactive-refresh";
import {
  PROACTIVE_REFRESH_ALARM_NAME,
  PROACTIVE_REFRESH_PERIOD_MINUTES,
  PROACTIVE_REFRESH_THRESHOLD_MS,
} from "../src/config/proactive-refresh";
import type { Account } from "../src/storage/accounts";

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

describe("selectAccountsDueForRefresh", () => {
  const now = 1_700_000_000_000;
  const threshold = PROACTIVE_REFRESH_THRESHOLD_MS;

  it("selects accounts whose expiresAt is within the threshold window", () => {
    const accounts: Account[] = [
      makeAccount({
        id: "due-soon",
        expiresAt: now + threshold - 60_000,
        refreshTokenExpiresAt: now + 7 * 24 * 60 * 60 * 1_000,
      }),
      makeAccount({
        id: "already-expired",
        expiresAt: now - 1,
        refreshTokenExpiresAt: now + 7 * 24 * 60 * 60 * 1_000,
      }),
      makeAccount({
        id: "plenty-of-time",
        expiresAt: now + threshold + 60_000,
        refreshTokenExpiresAt: now + 7 * 24 * 60 * 60 * 1_000,
      }),
    ];

    expect(selectAccountsDueForRefresh(accounts, now, threshold)).toEqual([
      "due-soon",
      "already-expired",
    ]);
  });

  it("skips accounts whose refreshTokenExpiresAt is in the past", () => {
    const accounts: Account[] = [
      makeAccount({
        id: "refresh-expired",
        expiresAt: now + 1,
        refreshTokenExpiresAt: now - 1,
      }),
    ];

    expect(selectAccountsDueForRefresh(accounts, now, threshold)).toEqual([]);
  });

  it("skips accounts without an expiresAt", () => {
    const accounts: Account[] = [
      makeAccount({ id: "no-expiry", expiresAt: null }),
    ];

    expect(selectAccountsDueForRefresh(accounts, now, threshold)).toEqual([]);
  });

  it("skips accounts without a refresh token", () => {
    const accounts: Account[] = [
      makeAccount({
        id: "no-refresh-token",
        refreshToken: null,
        expiresAt: now + 1,
      }),
    ];

    expect(selectAccountsDueForRefresh(accounts, now, threshold)).toEqual([]);
  });

  it("skips invalidated accounts", () => {
    const accounts: Account[] = [
      makeAccount({
        id: "invalidated",
        invalidated: true,
        invalidatedReason: "refresh_failed",
        expiresAt: now + 1,
      }),
    ];

    expect(selectAccountsDueForRefresh(accounts, now, threshold)).toEqual([]);
  });
});

describe("selectAccountsWithExpiredRefreshToken", () => {
  const now = 1_700_000_000_000;

  it("selects accounts whose refreshTokenExpiresAt is in the past", () => {
    const accounts: Account[] = [
      makeAccount({ id: "expired", refreshTokenExpiresAt: now - 1 }),
      makeAccount({ id: "still-valid", refreshTokenExpiresAt: now + 60_000 }),
      makeAccount({ id: "no-expiry", refreshTokenExpiresAt: null }),
    ];

    expect(selectAccountsWithExpiredRefreshToken(accounts, now)).toEqual([
      "expired",
    ]);
  });

  it("skips invalidated accounts even when refreshTokenExpiresAt is past", () => {
    const accounts: Account[] = [
      makeAccount({
        id: "expired-invalidated",
        invalidated: true,
        invalidatedReason: "refresh_failed",
        refreshTokenExpiresAt: now - 1,
      }),
    ];

    expect(selectAccountsWithExpiredRefreshToken(accounts, now)).toEqual([]);
  });
});

describe("createProactiveRefreshService", () => {
  const alarmsCreateMock = vi.fn(async () => undefined);
  const alarmsGetMock = vi.fn<
    (name: string) => Promise<{ periodInMinutes?: number } | undefined>
  >();
  const listAccountsMock = vi.fn<() => Promise<Account[]>>();
  const refreshAccountTokenMock =
    vi.fn<(accountId: string) => Promise<{ ok: true; token: string }>>();
  const markAccountInvalidatedMock =
    vi.fn<(accountId: string, reason: "expired") => Promise<void>>();

  beforeEach(() => {
    alarmsCreateMock.mockClear();
    alarmsGetMock.mockReset();
    alarmsGetMock.mockResolvedValue(undefined);
    listAccountsMock.mockReset();
    refreshAccountTokenMock.mockReset();
    refreshAccountTokenMock.mockResolvedValue({ ok: true, token: "t" });
    markAccountInvalidatedMock.mockReset();
    markAccountInvalidatedMock.mockResolvedValue(undefined);
    vi.stubGlobal("browser", {
      alarms: { create: alarmsCreateMock, get: alarmsGetMock },
    });
  });

  function buildService(nowValue: number) {
    return createProactiveRefreshService({
      refreshCoordinator: { refreshAccountToken: refreshAccountTokenMock },
      listAccounts: listAccountsMock,
      markAccountInvalidated: markAccountInvalidatedMock,
      now: () => nowValue,
    });
  }

  it("scheduleAlarm creates the alarm when no existing alarm is registered", async () => {
    alarmsGetMock.mockResolvedValue(undefined);
    const service = buildService(1_700_000_000_000);

    await service.scheduleAlarm();

    expect(alarmsGetMock).toHaveBeenCalledWith(PROACTIVE_REFRESH_ALARM_NAME);
    expect(alarmsCreateMock).toHaveBeenCalledWith(PROACTIVE_REFRESH_ALARM_NAME, {
      periodInMinutes: PROACTIVE_REFRESH_PERIOD_MINUTES,
    });
  });

  it("scheduleAlarm does not re-create an existing alarm that matches the configured period", async () => {
    alarmsGetMock.mockResolvedValue({
      periodInMinutes: PROACTIVE_REFRESH_PERIOD_MINUTES,
    });
    const service = buildService(1_700_000_000_000);

    await service.scheduleAlarm();

    expect(alarmsCreateMock).not.toHaveBeenCalled();
  });

  it("scheduleAlarm recreates the alarm when the existing period differs", async () => {
    alarmsGetMock.mockResolvedValue({
      periodInMinutes: PROACTIVE_REFRESH_PERIOD_MINUTES + 5,
    });
    const service = buildService(1_700_000_000_000);

    await service.scheduleAlarm();

    expect(alarmsCreateMock).toHaveBeenCalledWith(PROACTIVE_REFRESH_ALARM_NAME, {
      periodInMinutes: PROACTIVE_REFRESH_PERIOD_MINUTES,
    });
  });

  it("handleAlarmFire ignores alarms with a different name", async () => {
    const service = buildService(1_700_000_000_000);

    await service.handleAlarmFire("something-else");

    expect(listAccountsMock).not.toHaveBeenCalled();
    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
  });

  it("handleAlarmFire refreshes every eligible account", async () => {
    const now = 1_700_000_000_000;
    const dueSoon = now + PROACTIVE_REFRESH_THRESHOLD_MS - 60_000;
    const futureRefresh = now + 60 * 60 * 1_000;
    listAccountsMock.mockResolvedValue([
      makeAccount({
        id: "acc-a",
        expiresAt: dueSoon,
        refreshTokenExpiresAt: futureRefresh,
      }),
      makeAccount({
        id: "acc-b",
        expiresAt: dueSoon,
        refreshTokenExpiresAt: futureRefresh,
      }),
      makeAccount({
        id: "acc-skip",
        expiresAt: now + PROACTIVE_REFRESH_THRESHOLD_MS + 60_000,
        refreshTokenExpiresAt: futureRefresh,
      }),
    ]);

    const service = buildService(now);
    await service.handleAlarmFire(PROACTIVE_REFRESH_ALARM_NAME);

    expect(refreshAccountTokenMock).toHaveBeenCalledTimes(2);
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-a");
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-b");
  });

  it("handleAlarmFire continues when one account refresh rejects", async () => {
    const now = 1_700_000_000_000;
    const futureRefresh = now + 60 * 60 * 1_000;
    listAccountsMock.mockResolvedValue([
      makeAccount({
        id: "acc-a",
        expiresAt: now + 1,
        refreshTokenExpiresAt: futureRefresh,
      }),
      makeAccount({
        id: "acc-b",
        expiresAt: now + 1,
        refreshTokenExpiresAt: futureRefresh,
      }),
    ]);
    refreshAccountTokenMock.mockRejectedValueOnce(new Error("transient"));
    refreshAccountTokenMock.mockResolvedValueOnce({ ok: true, token: "t" });

    const service = buildService(now);

    await expect(
      service.handleAlarmFire(PROACTIVE_REFRESH_ALARM_NAME),
    ).resolves.toBeUndefined();
    expect(refreshAccountTokenMock).toHaveBeenCalledTimes(2);
  });

  it("handleAlarmFire invalidates accounts whose refresh token has expired", async () => {
    const now = 1_700_000_000_000;
    listAccountsMock.mockResolvedValue([
      makeAccount({
        id: "refresh-expired",
        expiresAt: now + 60_000,
        refreshTokenExpiresAt: now - 1,
      }),
    ]);

    const service = buildService(now);
    await service.handleAlarmFire(PROACTIVE_REFRESH_ALARM_NAME);

    expect(markAccountInvalidatedMock).toHaveBeenCalledWith(
      "refresh-expired",
      "expired",
    );
    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
  });

  it("handleAlarmFire processes refresh and invalidation concurrently", async () => {
    const now = 1_700_000_000_000;
    listAccountsMock.mockResolvedValue([
      makeAccount({
        id: "due",
        expiresAt: now + PROACTIVE_REFRESH_THRESHOLD_MS - 1,
        refreshTokenExpiresAt: now + 60 * 60 * 1_000,
      }),
      makeAccount({
        id: "refresh-expired",
        expiresAt: now + 60_000,
        refreshTokenExpiresAt: now - 1,
      }),
    ]);

    const service = buildService(now);
    await service.handleAlarmFire(PROACTIVE_REFRESH_ALARM_NAME);

    expect(refreshAccountTokenMock).toHaveBeenCalledWith("due");
    expect(markAccountInvalidatedMock).toHaveBeenCalledWith(
      "refresh-expired",
      "expired",
    );
  });
});
