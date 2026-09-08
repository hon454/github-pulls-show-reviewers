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
import { isRefreshAccountInstallationsMessage } from "../src/runtime/installation-refresh";
import { isOpenOptionsPageMessage } from "../src/runtime/options-page";
import { accountMutations } from "../src/storage/accounts";
import { accountAuthMessageSchema } from "../src/runtime/account-auth";
import { accountMutationMessageSchema } from "../src/runtime/account-mutations";

export default defineBackground(() => {
  // All later owner operations also await this same commit queue. Failure is
  // retryable on the next operation, without exposing stored auth in logs.
  void accountMutations.initialize().catch(() => undefined);
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
    listAccounts: accountMutations.listAccounts,
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
      sender: { id?: string; url?: string } | undefined,
      sendResponse: (response?: unknown) => void,
    ) => {
      if (sender?.id !== browser.runtime.id) return undefined;
      // Chrome MV3 needs true + sendResponse to keep an async channel open.
      const authMessage = accountAuthMessageSchema.safeParse(message);
      if (authMessage.success) {
        const { type, accountId, generation } = authMessage.data;
        const operation =
          type === "refreshAccessToken"
            ? coordinator.refreshAccountToken(accountId, generation)
            : coordinator
                .invalidateAccountToken(accountId, generation)
                .then(() => ({ ok: true }));
        operation.then(sendResponse, () => sendResponse(undefined));
        return true;
      }
      const mutationMessage = accountMutationMessageSchema.safeParse(message);
      if (mutationMessage.success) {
        // Auth replacements/removals originate in the options page. Do not
        // introduce a content-script endpoint that returns account credentials.
        if (sender.url !== browser.runtime.getURL("/options.html"))
          return undefined;
        const mutation = mutationMessage.data;
        const operation =
          mutation.type === "upsertAccountByLogin"
            ? accountMutations
                .upsertAccountByLogin(mutation.input)
                .then((account) => ({ ok: true, account }))
            : accountMutations
                .removeAccount(mutation.accountId)
                .then(() => ({ ok: true }));
        // Never log an input/schema error: account payloads contain secrets.
        operation.then(sendResponse, () => sendResponse({ ok: false }));
        return true;
      }
      if (isOpenOptionsPageMessage(message)) {
        browser.runtime.openOptionsPage().then(
          () => sendResponse({ ok: true }),
          (error) => {
            console.error(
              "[GitHub Pulls Show Reviewers] Failed to open options page.",
              error,
            );
            sendResponse({ ok: false });
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
