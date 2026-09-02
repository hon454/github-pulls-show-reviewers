import type { ContentScriptContext } from "wxt/utils/content-script-context";

import {
  buildReviewerCacheKey,
  clearReviewerCache,
  getReviewerCacheEntry,
  isReviewerCacheEntryFresh,
  markReviewerCacheStaleForRepository,
  setCachedReviewerSummary,
} from "../../cache/reviewer-cache";
import type { PullReviewerSummary } from "../../github/api";
import { parsePullListRoute } from "../../github/routes";
import type { Account } from "../../storage/accounts";
import {
  DEFAULT_PREFERENCES,
  getPreferences,
  isAccountsChange,
  isPreferencesChange,
  type Preferences,
} from "../../storage/preferences";

import { createSelfHealingAccountResolver } from "./account-resolution";
import {
  clearRenderedReviewerState,
  ensureReviewerMount,
  ensureReviewerStyles,
  extractPullNumber,
  mountHasRenderedChips,
  renderLoading,
  renderReviewers,
} from "./dom";
import { createFallbackAccountIntegration } from "./fallback-account";
import {
  createPageMetadataCoordinator,
  type PageMetadataFailure,
} from "./page-metadata";
import {
  collectVisiblePullNumbers,
  createReviewerRowLifecycle,
} from "./row-lifecycle";
import {
  fetchReviewerSummary,
  isAbortError,
  requestInstallationsRefresh,
  shouldRetryWithFallbackAccount,
} from "./runtime-requests";
import { buildReviewers } from "./view-model";

export type ReviewerBootOptions = {
  onRowFailure?: (signal: {
    owner: string;
    repo: string;
    account: Account | null;
    error: unknown;
  }) => void;
};

export function bootReviewerListPage(
  ctx: ContentScriptContext,
  options?: ReviewerBootOptions,
): void {
  ensureReviewerStyles();

  let currentRoute = parsePullListRoute(window.location.pathname);
  let currentHref = window.location.href;
  type InflightRequest = {
    promise: Promise<void>;
    controller: AbortController;
  };
  const inflightRequests = new Map<string, InflightRequest>();
  let cachedPreferences: Promise<Preferences> | null = null;
  const accountResolver = createSelfHealingAccountResolver({
    requestRefresh: requestInstallationsRefresh,
  });
  const fallbackAccounts = createFallbackAccountIntegration((owner) =>
    accountResolver.resolveFallbackAccount(owner),
  );
  const pageMetadata = createPageMetadataCoordinator({ fallbackAccounts });
  const rowLifecycle = createReviewerRowLifecycle({
    getRoute: () => currentRoute,
    processRow,
    markPageMetadataStale: pageMetadata.markStale,
  });

  function abortInflightRequests(): void {
    for (const request of inflightRequests.values()) {
      request.controller.abort();
    }
    inflightRequests.clear();
    pageMetadata.abortAndClear();
  }

  function readPreferences(): Promise<Preferences> {
    if (cachedPreferences == null) {
      cachedPreferences = getPreferences().catch(() => DEFAULT_PREFERENCES);
    }
    return cachedPreferences;
  }

  async function renderSummaryForMount(
    mount: HTMLElement,
    route: NonNullable<typeof currentRoute>,
    summary: PullReviewerSummary | undefined,
  ): Promise<void> {
    if (!summary) return;
    const preferences = await readPreferences();
    const reviewers = buildReviewers(route, summary, {
      openPullsOnly: preferences.openPullsOnly,
    });
    renderReviewers(mount, reviewers, {
      showStateBadge: preferences.showStateBadge,
      showReviewerName: preferences.showReviewerName,
    });
  }

  function reportPageMetadataFailure(
    route: NonNullable<typeof currentRoute>,
    failure: PageMetadataFailure,
  ): void {
    if (failure.reported) {
      return;
    }
    failure.reported = true;
    options?.onRowFailure?.({
      owner: route.owner,
      repo: route.repo,
      account: failure.account,
      error: failure.error,
    });
  }

  async function processRow(row: Element): Promise<void> {
    if (currentRoute == null) return;

    const pullNumber = extractPullNumber(row);
    if (pullNumber == null) return;

    const mount = ensureReviewerMount(row);
    if (mount == null) return;

    const route = currentRoute;
    const cacheKey = buildReviewerCacheKey(route.owner, route.repo, pullNumber);
    rowLifecycle.recordFingerprint(row, pullNumber, route);
    const cachedEntry = getReviewerCacheEntry(cacheKey);
    if (cachedEntry != null) {
      await renderSummaryForMount(mount, route, cachedEntry.summary);
      if (isReviewerCacheEntryFresh(cachedEntry)) {
        return;
      }
    }

    const existingRequest = inflightRequests.get(cacheKey);
    if (existingRequest) {
      const existingEntry = getReviewerCacheEntry(cacheKey);
      if (existingEntry != null) {
        await renderSummaryForMount(mount, route, existingEntry.summary);
      } else if (!mountHasRenderedChips(mount)) {
        renderLoading(mount);
      }
      try {
        await existingRequest.promise;
      } catch {
        // The tracked request reports its own failure.
      }
      await renderSummaryForMount(
        mount,
        route,
        getReviewerCacheEntry(cacheKey)?.summary,
      );
      return;
    }

    if (cachedEntry == null && !mountHasRenderedChips(mount)) {
      renderLoading(mount);
    }

    const controller = new AbortController();
    let request: InflightRequest | null = null;
    const promise = (async () => {
      const account = await accountResolver.resolveAccount(
        route.owner,
        route.repo,
      );
      const metadataResult = await pageMetadata.get({
        route,
        account,
        targetPullNumbers: collectVisiblePullNumbers(),
        signal: controller.signal,
      });
      if (metadataResult.failure?.suppressRowFallback) {
        reportPageMetadataFailure(route, metadataResult.failure);
        clearReviewerMountWithoutCache(mount, cacheKey);
        return;
      }
      const pullMetadata = metadataResult.metadata.get(pullNumber);
      const cachedFallbackAccount =
        account == null ? fallbackAccounts.read(route.owner) : undefined;
      const summaryAccount = cachedFallbackAccount ?? account;
      if (controller.signal.aborted) {
        return;
      }

      try {
        const summary = await fetchReviewerSummary({
          account: summaryAccount,
          owner: route.owner,
          repo: route.repo,
          pullNumber,
          signal: controller.signal,
          ...(pullMetadata == null ? {} : { pullMetadata }),
        });
        if (controller.signal.aborted) {
          return;
        }
        setCachedReviewerSummary(cacheKey, summary);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          return;
        }
        let failureAccount = summaryAccount;
        let failureError = error;
        if (
          account == null &&
          summaryAccount == null &&
          shouldRetryWithFallbackAccount(error)
        ) {
          const fallbackAccount = await fallbackAccounts.get(route.owner);
          if (controller.signal.aborted) {
            return;
          }
          if (fallbackAccount != null) {
            try {
              const summary = await fetchReviewerSummary({
                account: fallbackAccount,
                owner: route.owner,
                repo: route.repo,
                pullNumber,
                signal: controller.signal,
                ...(pullMetadata == null ? {} : { pullMetadata }),
              });
              if (controller.signal.aborted) {
                return;
              }
              setCachedReviewerSummary(cacheKey, summary);
              return;
            } catch (fallbackError) {
              if (isAbortError(fallbackError) || controller.signal.aborted) {
                return;
              }
              failureAccount = fallbackAccount;
              failureError = fallbackError;
            }
          }
        }
        clearReviewerMountWithoutCache(mount, cacheKey);
        options?.onRowFailure?.({
          owner: route.owner,
          repo: route.repo,
          account: failureAccount,
          error: failureError,
        });
      } finally {
        if (request != null && inflightRequests.get(cacheKey) === request) {
          inflightRequests.delete(cacheKey);
        }
      }
    })();
    request = { controller, promise };

    inflightRequests.set(cacheKey, request);
    try {
      await request.promise;
    } catch {
      // Errors are handled inside the async block.
    }

    if (controller.signal.aborted) {
      return;
    }

    await renderSummaryForMount(
      mount,
      route,
      getReviewerCacheEntry(cacheKey)?.summary,
    );
  }

  function refreshRoute(force = false): void {
    const nextHref = window.location.href;
    if (!force && nextHref === currentHref) return;

    currentHref = nextHref;
    const previousRoute = currentRoute;
    currentRoute = parsePullListRoute(window.location.pathname);
    abortInflightRequests();

    if (
      previousRoute?.owner !== currentRoute?.owner ||
      previousRoute?.repo !== currentRoute?.repo
    ) {
      clearReviewerCache();
      rowLifecycle.clearFingerprints();
    } else if (currentRoute != null) {
      markReviewerCacheStaleForRepository(
        currentRoute.owner,
        currentRoute.repo,
      );
    }

    rowLifecycle.processRows();
  }

  const observer = rowLifecycle.observe();
  rowLifecycle.processRows();

  ctx.addEventListener(window, "wxt:locationchange", () => refreshRoute(true));
  ctx.addEventListener(window, "popstate", () => refreshRoute(true));
  ctx.addEventListener(document, "turbo:render", () => refreshRoute(true));
  ctx.addEventListener(document, "pjax:end", () => refreshRoute(true));

  const storageListener: Parameters<
    typeof browser.storage.onChanged.addListener
  >[0] = (changes, areaName) => {
    if (areaName !== "local") return;

    if (isPreferencesChange(changes)) {
      cachedPreferences = null;
      rowLifecycle.processRows();
      return;
    }

    if (isAccountsChange(changes)) {
      clearReviewerCache();
      fallbackAccounts.clear();
      abortInflightRequests();
      rowLifecycle.processRows();
    }
  };

  browser.storage.onChanged.addListener(storageListener);
  ctx.setInterval(() => refreshRoute(), 1000);
  ctx.onInvalidated(() => {
    observer.disconnect();
    browser.storage.onChanged.removeListener(storageListener);
  });
}

function clearReviewerMountWithoutCache(
  mount: HTMLElement,
  cacheKey: ReturnType<typeof buildReviewerCacheKey>,
): void {
  if (getReviewerCacheEntry(cacheKey) != null) {
    return;
  }
  mount.replaceChildren();
  mount.removeAttribute("title");
  clearRenderedReviewerState(mount);
}
