import { createRefreshCoordinator } from "../src/auth/refresh-coordinator";
import { createInstallationRefreshService } from "../src/background/installation-refresh";
import { createProactiveRefreshService } from "../src/background/proactive-refresh";
import { createReviewerFetchService } from "../src/background/reviewer-fetch";
import { getGitHubAppConfig } from "../src/config/github-app";
import {
  isCancelPullReviewerSummaryMessage,
  isFetchPullReviewerMetadataBatchMessage,
  isFetchPullReviewerSummaryMessage,
} from "../src/runtime/reviewer-fetch";
import {
  isRefreshAccountInstallationsMessage,
} from "../src/runtime/installation-refresh";
import {
  listAccounts,
  markAccountInvalidated,
} from "../src/storage/accounts";

export default defineBackground(() => {
  const coordinator = createRefreshCoordinator({
    getClientId: () => getGitHubAppConfig().clientId,
  });
  const reviewerFetchService = createReviewerFetchService({
    refreshCoordinator: coordinator,
  });
  const installationRefreshService = createInstallationRefreshService({
    refreshCoordinator: coordinator,
  });
  const proactiveRefreshService = createProactiveRefreshService({
    refreshCoordinator: coordinator,
    listAccounts,
    markAccountInvalidated,
    now: () => Date.now(),
  });

  proactiveRefreshService.scheduleAlarm().catch((error) => {
    console.error(
      "[GitHub Pulls Show Reviewers] Failed to schedule proactive refresh alarm.",
      error,
    );
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    proactiveRefreshService.handleAlarmFire(alarm.name).catch((error) => {
      console.error(
        "[GitHub Pulls Show Reviewers] Proactive refresh alarm failed.",
        error,
      );
    });
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
    (
      message: unknown,
      sender: { id?: string } | undefined,
      sendResponse: (response?: unknown) => void,
    ) => {
      // Reject messages from other extensions or extension pages. Only
      // components of this extension (content scripts, options page) are
      // allowed to trigger a token refresh — otherwise a third party could
      // ask us to refresh an arbitrary accountId and observe the returned
      // token.
      if (sender?.id !== browser.runtime.id) {
        return undefined;
      }
      // Chrome MV3 does not reliably await a Promise returned from an
      // `onMessage` listener. Returning `true` keeps the message channel
      // open and `sendResponse` delivers the async result to the caller.
      if (
        message != null &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "refreshAccessToken" &&
        typeof (message as { accountId?: unknown }).accountId === "string"
      ) {
        coordinator
          .refreshAccountToken(
            (message as { accountId: string }).accountId,
          )
          .then(
            (outcome) => sendResponse(outcome),
            (error) => {
              console.error(
                "[GitHub Pulls Show Reviewers] refreshAccountToken failed.",
                error,
              );
              sendResponse(undefined);
            },
          );
        return true;
      }
      if (isFetchPullReviewerSummaryMessage(message)) {
        reviewerFetchService.handleFetchMessage(message).then(
          (response) => sendResponse(response),
          (error) => {
            console.error(
              "[GitHub Pulls Show Reviewers] Reviewer fetch handler crashed.",
              error,
            );
            sendResponse(undefined);
          },
        );
        return true;
      }
      if (isCancelPullReviewerSummaryMessage(message)) {
        reviewerFetchService.cancelRequest(message.requestId);
        return undefined;
      }
      if (isFetchPullReviewerMetadataBatchMessage(message)) {
        reviewerFetchService.handleMetadataBatchMessage(message).then(
          (response) => sendResponse(response),
          (error) => {
            console.error(
              "[GitHub Pulls Show Reviewers] Reviewer metadata batch handler crashed.",
              error,
            );
            sendResponse(undefined);
          },
        );
        return true;
      }
      if (isRefreshAccountInstallationsMessage(message)) {
        installationRefreshService
          .refreshAccountInstallations(message.accountId)
          .then(
            (outcome) => sendResponse(outcome),
            (error) => {
              console.error(
                "[GitHub Pulls Show Reviewers] refreshAccountInstallations failed.",
                error,
              );
              sendResponse(undefined);
            },
          );
        return true;
      }
      return undefined;
    },
  );
});
