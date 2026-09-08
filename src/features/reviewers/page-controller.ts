import { getLocaleStore } from "../../i18n/browser";

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
  parsePreferences,
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
  createReviewerOutcomeCoordinator,
  type ReviewerOutcomeSnapshot,
} from "./outcomes";
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
import { createAbortAwareRequestScheduler } from "./request-scheduler";
import { buildReviewers } from "./view-model";

export const REVIEWER_SUMMARY_CONCURRENCY_LIMIT = 4;

export type ReviewerBootOptions = {
  onOutcomes?: (snapshot: ReviewerOutcomeSnapshot) => void;
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
  let generation = 0;
  let disposed = false;
  const mountOperations = new WeakMap<HTMLElement, object>();
  // Keep the last request identity after settlement to reject delayed renders.
  const requestOwners = new Map<string, object>();
  type InflightRequest = {
    owner: object;
    promise: Promise<void>;
    controller: AbortController;
    consumers: Map<HTMLElement, () => boolean>;
  };
  const localeStore = getLocaleStore();
  type Presentation =
    | { kind: "loading" }
    | {
        kind: "resolved";
        source: {
          route: NonNullable<typeof currentRoute>;
          summary: PullReviewerSummary;
        } | null;
        preferences: Preferences;
      };
  const presentations = new WeakMap<HTMLElement, Presentation>();
  function renderPresentation(mount: HTMLElement): void {
    const state = presentations.get(mount);
    if (!state) return;
    const locale = localeStore.getSnapshot();
    if (state.kind === "loading") renderLoading(mount, locale);
    else {
      const entries =
        state.source == null
          ? []
          : buildReviewers(state.source.route, state.source.summary, {
              openPullsOnly: state.preferences.openPullsOnly,
            });
      renderReviewers(mount, entries, state.preferences, locale);
    }
  }
  function showLoading(mount: HTMLElement): void {
    presentations.set(mount, { kind: "loading" });
    renderPresentation(mount);
  }
  function renderLocale(): void {
    // Never enter processRows: even missing/stale caches must remain untouched.
    document
      .querySelectorAll<HTMLElement>("[data-ghpsr-root]")
      .forEach(renderPresentation);
  }
  function renderDisplay(preferences: Preferences): void {
    document
      .querySelectorAll<HTMLElement>("[data-ghpsr-root]")
      .forEach((mount) => {
        const state = presentations.get(mount);
        if (state?.kind !== "resolved") return;
        presentations.set(mount, { ...state, preferences });
        renderPresentation(mount);
      });
  }
  let unsubscribeLocale: (() => void) | undefined;
  function syncLocaleSubscription(): void {
    if (currentRoute != null && !unsubscribeLocale) {
      unsubscribeLocale = localeStore.subscribe(renderLocale);
      renderLocale();
    } else if (currentRoute == null) {
      unsubscribeLocale?.();
      unsubscribeLocale = undefined;
    }
  }
  syncLocaleSubscription();
  const inflightRequests = new Map<string, InflightRequest>();
  let cachedPreferences: Promise<Preferences> | null = null;
  let latestDisplayPreferences: Preferences | null = null;
  const accountResolver = createSelfHealingAccountResolver({
    requestRefresh: requestInstallationsRefresh,
  });
  const fallbackAccounts = createFallbackAccountIntegration((owner) =>
    accountResolver.resolveFallbackAccount(owner),
  );
  const pageMetadata = createPageMetadataCoordinator({ fallbackAccounts });
  const reviewerSummaryScheduler = createAbortAwareRequestScheduler(
    REVIEWER_SUMMARY_CONCURRENCY_LIMIT,
  );
  const outcomes = createReviewerOutcomeCoordinator((snapshot) => {
    if (!disposed) options?.onOutcomes?.(snapshot);
  });
  function resetOutcomes(): void {
    outcomes.reset({
      generation,
      pathname: window.location.pathname,
      pullNumbers: currentRoute == null ? [] : collectVisiblePullNumbers(),
    });
  }
  resetOutcomes();
  const rowLifecycle = createReviewerRowLifecycle({
    getRoute: () => currentRoute,
    processRow,
    markPageMetadataStale: pageMetadata.markStale,
    onRowsChanged: () => outcomes.reconcile(collectVisiblePullNumbers()),
  });

  function abortInflightRequests(): void {
    generation += 1;
    for (const request of inflightRequests.values()) {
      request.controller.abort();
    }
    inflightRequests.clear();
    requestOwners.clear();
    pageMetadata.abortAndClear();
    resetOutcomes();
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
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!summary || !isCurrent()) return;
    const loadedPreferences = await readPreferences();
    if (!isCurrent()) return;
    presentations.set(mount, {
      kind: "resolved",
      source: { route, summary },
      preferences: latestDisplayPreferences ?? loadedPreferences,
    });
    renderPresentation(mount);
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
    if (disposed || currentRoute == null || !row.isConnected) return;

    const pullNumber = extractPullNumber(row);
    if (pullNumber == null) return;

    const mount = ensureReviewerMount(row);
    if (mount == null) return;

    const route = currentRoute;
    const cacheKey = buildReviewerCacheKey(route.owner, route.repo, pullNumber);
    let requestOwner = requestOwners.get(cacheKey);
    const rowGeneration = generation;
    const operation = {};
    mountOperations.set(mount, operation);
    const isRowCurrent = () =>
      !disposed &&
      generation === rowGeneration &&
      currentRoute === route &&
      row.isConnected &&
      extractPullNumber(row) === pullNumber;
    const isOperationCurrent = () =>
      isRowCurrent() &&
      row.contains(mount) &&
      mountOperations.get(mount) === operation &&
      requestOwners.get(cacheKey) === requestOwner;
    rowLifecycle.recordFingerprint(row, pullNumber, route);
    const cachedEntry = getReviewerCacheEntry(cacheKey);
    if (cachedEntry == null || !isReviewerCacheEntryFresh(cachedEntry))
      outcomes.pending(rowGeneration, pullNumber);
    if (cachedEntry != null) {
      await renderSummaryForMount(
        mount,
        route,
        cachedEntry.summary,
        isOperationCurrent,
      );
      if (!isOperationCurrent()) return;
      if (isReviewerCacheEntryFresh(cachedEntry)) {
        outcomes.cached(rowGeneration, pullNumber);
        return;
      }
    }

    const existingRequest = inflightRequests.get(cacheKey);
    if (existingRequest) {
      requestOwner = existingRequest.owner;
      outcomes.begin(rowGeneration, pullNumber, existingRequest.owner);
      existingRequest.consumers.set(mount, isRowCurrent);
      const existingEntry = getReviewerCacheEntry(cacheKey);
      if (existingEntry != null) {
        await renderSummaryForMount(
          mount,
          route,
          existingEntry.summary,
          isOperationCurrent,
        );
        if (!isOperationCurrent()) return;
      } else if (!mountHasRenderedChips(mount)) {
        showLoading(mount);
      }
      try {
        await existingRequest.promise;
      } catch {
        // The tracked request reports its own failure.
      }
      if (!isOperationCurrent() || existingRequest.controller.signal.aborted) {
        return;
      }
      const settledSummary = getReviewerCacheEntry(cacheKey)?.summary;
      if (settledSummary == null) {
        clearReviewerMountWithoutCache(mount, cacheKey);
      } else {
        await renderSummaryForMount(
          mount,
          route,
          settledSummary,
          isOperationCurrent,
        );
      }
      return;
    }

    if (cachedEntry == null && !mountHasRenderedChips(mount)) {
      showLoading(mount);
    }

    const controller = new AbortController();
    requestOwner = {};
    requestOwners.set(cacheKey, requestOwner);
    const outcomeOwner = requestOwner;
    outcomes.begin(rowGeneration, pullNumber, outcomeOwner);
    let request: InflightRequest | null = null;
    const consumers = new Map([[mount, isRowCurrent]]);
    // Data belongs to live rows, even if their presentation mounts were removed.
    // A replacement row may still need the shared request after its owner left.
    const isRequestCurrent = () =>
      !controller.signal.aborted &&
      request != null &&
      inflightRequests.get(cacheKey) === request &&
      [...consumers.values()].some((isCurrent) => isCurrent());
    const promise = (async () => {
      let account: Account | null = null;
      try {
        account = await accountResolver.resolveAccount(route.owner, route.repo);
        if (!isRequestCurrent()) {
          return;
        }
        const metadataResult = await pageMetadata.get({
          route,
          account,
          targetPullNumbers: collectVisiblePullNumbers(),
          signal: controller.signal,
        });
        if (!isRequestCurrent()) {
          return;
        }
        if (metadataResult.failure?.suppressRowFallback) {
          outcomes.settle(rowGeneration, pullNumber, outcomeOwner, {
            status: "failure",
            failure: metadataResult.failure,
          });
          reportPageMetadataFailure(route, metadataResult.failure);
          if (isOperationCurrent())
            clearReviewerMountWithoutCache(mount, cacheKey);
          return;
        }
        const pullMetadata = metadataResult.metadata.get(pullNumber);
        const cachedFallbackAccount =
          account == null ? fallbackAccounts.read(route.owner) : undefined;
        const summaryAccount = cachedFallbackAccount ?? account;
        if (!isRequestCurrent()) {
          return;
        }

        try {
          const summary = await reviewerSummaryScheduler.run(() => {
            if (!isRequestCurrent()) controller.abort();
            return fetchReviewerSummary({
              account: summaryAccount,
              owner: route.owner,
              repo: route.repo,
              pullNumber,
              signal: controller.signal,
              ...(pullMetadata == null ? {} : { pullMetadata }),
            });
          }, controller.signal);
          if (!isRequestCurrent()) {
            return;
          }
          setCachedReviewerSummary(cacheKey, summary);
          outcomes.settle(rowGeneration, pullNumber, outcomeOwner, {
            status: "success",
          });
        } catch (error) {
          if (isAbortError(error) || !isRequestCurrent()) {
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
            if (!isRequestCurrent()) {
              return;
            }
            if (fallbackAccount != null) {
              try {
                const summary = await reviewerSummaryScheduler.run(() => {
                  if (!isRequestCurrent()) controller.abort();
                  return fetchReviewerSummary({
                    account: fallbackAccount,
                    owner: route.owner,
                    repo: route.repo,
                    pullNumber,
                    signal: controller.signal,
                    ...(pullMetadata == null ? {} : { pullMetadata }),
                  });
                }, controller.signal);
                if (!isRequestCurrent()) {
                  return;
                }
                setCachedReviewerSummary(cacheKey, summary);
                outcomes.settle(rowGeneration, pullNumber, outcomeOwner, {
                  status: "success",
                });
                return;
              } catch (fallbackError) {
                if (isAbortError(fallbackError) || !isRequestCurrent()) {
                  return;
                }
                failureAccount = fallbackAccount;
                failureError = fallbackError;
              }
            }
          }
          if (isOperationCurrent())
            clearReviewerMountWithoutCache(mount, cacheKey);
          outcomes.settle(rowGeneration, pullNumber, outcomeOwner, {
            status: "failure",
            failure: { account: failureAccount, error: failureError },
          });
          options?.onRowFailure?.({
            owner: route.owner,
            repo: route.repo,
            account: failureAccount,
            error: failureError,
          });
        }
      } catch (error) {
        if (isAbortError(error) || !isRequestCurrent()) {
          return;
        }
        if (isOperationCurrent())
          clearReviewerMountWithoutCache(mount, cacheKey);
        outcomes.settle(rowGeneration, pullNumber, outcomeOwner, {
          status: "failure",
          failure: { account, error },
        });
        options?.onRowFailure?.({
          owner: route.owner,
          repo: route.repo,
          account,
          error,
        });
      } finally {
        if (request != null && inflightRequests.get(cacheKey) === request) {
          inflightRequests.delete(cacheKey);
        }
      }
    })();
    request = { owner: outcomeOwner, controller, promise, consumers };

    inflightRequests.set(cacheKey, request);
    try {
      await request.promise;
    } catch {
      // Errors are handled inside the async block.
    }

    if (!isOperationCurrent() || controller.signal.aborted) {
      return;
    }

    await renderSummaryForMount(
      mount,
      route,
      getReviewerCacheEntry(cacheKey)?.summary,
      isOperationCurrent,
    );
  }

  function refreshRoute(force = false): void {
    const nextHref = window.location.href;
    if (!force && nextHref === currentHref) return;

    currentHref = nextHref;
    const previousRoute = currentRoute;
    currentRoute = parsePullListRoute(window.location.pathname);
    abortInflightRequests();
    syncLocaleSubscription();

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

    let displayChanged = false;
    if (isPreferencesChange(changes)) {
      const previous = parsePreferences(changes.preferences?.oldValue);
      const next = parsePreferences(changes.preferences?.newValue);
      displayChanged =
        previous.showStateBadge !== next.showStateBadge ||
        previous.showReviewerName !== next.showReviewerName ||
        previous.openPullsOnly !== next.openPullsOnly;
      if (displayChanged) {
        latestDisplayPreferences = next;
        cachedPreferences = Promise.resolve(next);
      }
    }

    if (isAccountsChange(changes)) {
      clearReviewerCache();
      fallbackAccounts.clear();
      abortInflightRequests();
      rowLifecycle.processRows();
    } else if (displayChanged && latestDisplayPreferences != null) {
      renderDisplay(latestDisplayPreferences);
    }
  };

  browser.storage.onChanged.addListener(storageListener);
  ctx.setInterval(() => refreshRoute(), 1000);
  ctx.onInvalidated(() => {
    disposed = true;
    observer.disconnect();
    unsubscribeLocale?.();
    unsubscribeLocale = undefined;
    browser.storage.onChanged.removeListener(storageListener);
    abortInflightRequests();
  });

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
    presentations.set(mount, {
      kind: "resolved",
      source: null,
      preferences: latestDisplayPreferences ?? DEFAULT_PREFERENCES,
    });
    renderPresentation(mount);
  }
}
