import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import {
  PROACTIVE_REFRESH_ALARM_NAME,
  PROACTIVE_REFRESH_PERIOD_MINUTES,
  PROACTIVE_REFRESH_THRESHOLD_MS,
} from "../config/proactive-refresh";
import type { Account } from "../storage/accounts";

export type ProactiveRefreshService = {
  scheduleAlarm(): Promise<void>;
  handleAlarmFire(alarmName: string): Promise<void>;
};

export function selectAccountsDueForRefresh(
  accounts: Account[],
  now: number,
  thresholdMs: number,
): string[] {
  const dueIds: string[] = [];
  for (const account of accounts) {
    if (account.invalidated) continue;
    if (account.refreshToken == null) continue;
    if (account.expiresAt == null) continue;
    if (
      account.refreshTokenExpiresAt != null &&
      account.refreshTokenExpiresAt <= now
    ) continue;
    if (account.expiresAt - now >= thresholdMs) continue;
    dueIds.push(account.id);
  }
  return dueIds;
}

export function selectAccountsWithExpiredRefreshToken(
  accounts: Account[],
  now: number,
): string[] {
  const expiredIds: string[] = [];
  for (const account of accounts) {
    if (account.invalidated) continue;
    if (account.refreshTokenExpiresAt == null) continue;
    if (account.refreshTokenExpiresAt > now) continue;
    expiredIds.push(account.id);
  }
  return expiredIds;
}

export function createProactiveRefreshService(input: {
  refreshCoordinator: RefreshCoordinator;
  listAccounts: () => Promise<Account[]>;
  markAccountInvalidated: (
    accountId: string,
    reason: "expired",
  ) => Promise<void>;
  now: () => number;
}): ProactiveRefreshService {
  return {
    async scheduleAlarm(): Promise<void> {
      const existing = await browser.alarms.get(PROACTIVE_REFRESH_ALARM_NAME);
      if (existing?.periodInMinutes === PROACTIVE_REFRESH_PERIOD_MINUTES) {
        return;
      }
      await browser.alarms.create(PROACTIVE_REFRESH_ALARM_NAME, {
        periodInMinutes: PROACTIVE_REFRESH_PERIOD_MINUTES,
      });
    },

    async handleAlarmFire(alarmName: string): Promise<void> {
      if (alarmName !== PROACTIVE_REFRESH_ALARM_NAME) return;

      const accounts = await input.listAccounts();
      const now = input.now();
      const dueIds = selectAccountsDueForRefresh(
        accounts,
        now,
        PROACTIVE_REFRESH_THRESHOLD_MS,
      );
      const expiredIds = selectAccountsWithExpiredRefreshToken(accounts, now);
      if (dueIds.length === 0 && expiredIds.length === 0) return;

      await Promise.allSettled([
        ...dueIds.map((accountId) =>
          input.refreshCoordinator.refreshAccountToken(accountId),
        ),
        ...expiredIds.map((accountId) =>
          input.markAccountInvalidated(accountId, "expired"),
        ),
      ]);
    },
  };
}
