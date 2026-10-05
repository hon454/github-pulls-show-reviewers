import { createRefreshCoordinator } from "../src/auth/refresh-coordinator";
import { createAccountIdentityBackfill } from "../src/background/account-identity";
import { createInstallationRefreshService } from "../src/background/installation-refresh";
import { createProactiveRefreshService } from "../src/background/proactive-refresh";
import { createReviewerFetchService } from "../src/background/reviewer-fetch";
import { getGitHubAppConfig } from "../src/config/github-app";
import { PROACTIVE_REFRESH_ALARM_NAME } from "../src/config/proactive-refresh";
import { createStoragePolicy } from "../src/background/storage-policy";
import { createUIBridge } from "../src/background/ui-bridge";
import { accountMutations } from "../src/storage/accounts";
import type { UISender } from "../src/background/ui-sender";

export default defineBackground(() => {
  const ensureReady = createStoragePolicy();
  const coordinator = createRefreshCoordinator({
    getClientId: () => getGitHubAppConfig().clientId,
  });
  const reviewerFetchService = createReviewerFetchService();
  const installationRefreshService = createInstallationRefreshService({
    refreshCoordinator: coordinator,
  });
  const proactiveRefreshService = createProactiveRefreshService({
    refreshCoordinator: coordinator,
    listAccounts: accountMutations.listAccounts,
    now: () => Date.now(),
  });
  const identityBackfill = createAccountIdentityBackfill();

  const bridge = createUIBridge({
    ensureReady,
    coordinator,
    reviewers: reviewerFetchService,
    installations: installationRefreshService,
  });
  void ensureReady()
    .then(() => bridge.initialize())
    .catch(() => undefined);
  void proactiveRefreshService.scheduleAlarm().catch(() => undefined);
  browser.runtime.onConnect.addListener(bridge.connect);
  browser.alarms.onAlarm.addListener((alarm) => {
    void ensureReady()
      .then(() => proactiveRefreshService.handleAlarmFire(alarm.name))
      // Records from before the stored user id gain it after token refresh.
      .then(() =>
        alarm.name === PROACTIVE_REFRESH_ALARM_NAME
          ? identityBackfill.backfillMissingUserIds()
          : undefined,
      )
      .catch(() => undefined);
  });

  browser.runtime.onInstalled.addListener((details) => {
    // Records from before the stored user id gain it right after the update.
    if (details.reason === "update")
      void ensureReady()
        .then(() => identityBackfill.backfillMissingUserIds())
        .catch(() => undefined);
    if (details.reason === "install") {
      browser.runtime.openOptionsPage().catch((error) => {
        console.error(
          "[GitHub Pulls Show Reviewers] Failed to open options page.",
          error,
        );
      });
    }
  });

  browser.action.onClicked.addListener(() => {
    browser.runtime.openOptionsPage().catch((error) => {
      console.error(
        "[GitHub Pulls Show Reviewers] Failed to open options page.",
        error,
      );
    });
  });

  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: UISender | undefined,
      sendResponse: (response?: unknown) => void,
    ) => {
      if (sender?.id !== browser.runtime.id) return undefined;
      // Chrome MV3 needs true + sendResponse for asynchronous capability replies.
      void bridge
        .handle(message, sender)
        .then(sendResponse, () =>
          sendResponse({ ok: false, error: "unavailable" }),
        );
      return true;
    },
  );
});
