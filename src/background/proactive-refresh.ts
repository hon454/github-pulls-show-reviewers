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
    if (account.expiresAt - now >= thresholdMs) continue;
    dueIds.push(account.id);
  }
  return dueIds;
}

export function createProactiveRefreshService(input: {
  refreshCoordinator: RefreshCoordinator;
  listAccounts: () => Promise<Account[]>;
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
      const dueIds = selectAccountsDueForRefresh(
        accounts,
        input.now(),
        PROACTIVE_REFRESH_THRESHOLD_MS,
      );
      if (dueIds.length === 0) return;

      await Promise.allSettled(
        dueIds.map((accountId) =>
          input.refreshCoordinator.refreshAccountToken(accountId),
        ),
      );
    },
  };
}
