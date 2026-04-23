import { createRefreshCoordinator } from "../src/auth/refresh-coordinator";
import { getGitHubAppConfig } from "../src/config/github-app";

export default defineBackground(() => {
  const coordinator = createRefreshCoordinator({
    getClientId: () => getGitHubAppConfig().clientId,
  });

  browser.runtime.onInstalled.addListener((details) => {
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

  browser.runtime.onMessage.addListener((message: unknown) => {
    if (
      message != null &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "refreshAccessToken" &&
      typeof (message as { accountId?: unknown }).accountId === "string"
    ) {
      return coordinator.refreshAccountToken(
        (message as { accountId: string }).accountId,
      );
    }
    return undefined;
  });
});
