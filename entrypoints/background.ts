import { createRefreshCoordinator } from "../src/auth/refresh-coordinator";
import { handleFetchPullReviewerSummaryMessage } from "../src/background/reviewer-fetch";
import { getGitHubAppConfig } from "../src/config/github-app";
import { isFetchPullReviewerSummaryMessage } from "../src/runtime/reviewer-fetch";

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

  browser.runtime.onMessage.addListener(
    (message: unknown, sender: { id?: string } | undefined) => {
      // Reject messages from other extensions or extension pages. Only
      // components of this extension (content scripts, options page) are
      // allowed to trigger a token refresh — otherwise a third party could
      // ask us to refresh an arbitrary accountId and observe the returned
      // token.
      if (sender?.id !== browser.runtime.id) {
        return undefined;
      }
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
      if (isFetchPullReviewerSummaryMessage(message)) {
        return handleFetchPullReviewerSummaryMessage({
          message,
          refreshCoordinator: coordinator,
        });
      }
      return undefined;
    },
  );
});
