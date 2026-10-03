import { getUIClient } from "../../runtime/ui-client";
import { getLocaleStore } from "../../i18n/browser";
import {
  beginRepositoryDiscovery,
  retireRepositoryDiscovery,
  type RepositoryDiscovery,
} from "../../runtime/repository-discovery";
import { ReviewerFetchRuntimeError } from "../../runtime/reviewer-fetch";

import type { ContentScriptContext } from "wxt/utils/content-script-context";

import {
  buildReviewerCacheKey,
  type CacheKey,
  clearReviewerCache,
  getReviewerCacheEntry,
  isReviewerCacheEntryFresh,
  markReviewerCacheStale,
  markReviewerCacheStaleForRepository,
  setCachedReviewerSummary,
} from "../../cache/reviewer-cache";
import type { PullReviewerSummary } from "../../github/api";
import { parsePullListRoute } from "../../github/routes";
import { githubSelectors } from "../../github/selectors";
import type {
  AccountSummary as Account,
  UISnapshot,
} from "../../runtime/ui-contract";
import {
  DEFAULT_PREFERENCES,
  getPreferences,
  type Preferences,
} from "../../runtime/preferences";

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
  type ReviewerFailure,
  type ReviewerOutcomeSnapshot,
} from "./outcomes";
import { createPageMetadataCoordinator } from "./page-metadata";
import {
  collectVisiblePullNumbers,
  createReviewerRowLifecycle,
} from "./row-lifecycle";
import {
  fetchReviewerSummary,
  isAbortError,
  readPrimaryRateLimitReset,
} from "./runtime-requests";
import {
  createReviewerRequestRegistry,
  type ReviewerRequest,
} from "./request-registry";
import { createAbortAwareRequestScheduler } from "./request-scheduler";
import { buildReviewers } from "./view-model";

export const REVIEWER_SUMMARY_CONCURRENCY_LIMIT = 4;
// Poll ticks to wait before reprocessing rows that survive a URL change. Two
// ticks guarantee at least one full interval for GitHub to replace the list.
const NAVIGATION_SETTLE_TICKS = 2;
// Survives controller remounts in this document. Only explicit page lifecycle
// invalidation allocates the next generation; rows/locale/TTL cannot allocate it.
const pageSession = crypto.randomUUID();
let discoveryGeneration = 0;

/** Thrown instead of dispatching a row while its account's quota is spent. */
class QuotaBlockedSkip {
  constructor(readonly failure: ReviewerFailure) {}
}

export type ReviewerBootOptions = {
  onOutcomes?: (snapshot: ReviewerOutcomeSnapshot) => void;
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
  let hydrated = false;
  let discovery: Promise<RepositoryDiscovery> | undefined;
  let activeDiscoveryGeneration = ++discoveryGeneration;
  function getDiscovery(route: NonNullable<typeof currentRoute>) {
    if (discovery) return discovery;
    const attempt = beginRepositoryDiscovery({
      ...route,
      pageSession,
      generation: activeDiscoveryGeneration,
    });
    discovery = attempt;
    // A transient rejection must not poison the generation. Forget it so a
    // later row event retries with the same admission identity; rows already
    // waiting on this attempt still fail, and nothing retries on its own.
    attempt.catch(() => {
      if (discovery === attempt) discovery = undefined;
    });
    return attempt;
  }
  type Route = NonNullable<typeof currentRoute>;
  /** One pass of one row through `processRow`. */
  type RowWork = {
    mount: HTMLElement;
    route: Route;
    pullNumber: string;
    cacheKey: CacheKey;
    generation: number;
    isRowCurrent: () => boolean;
    /** The row is current and this pass and its request still own the mount. */
    isOperationCurrent: () => boolean;
  };
  const mountOperations = new WeakMap<HTMLElement, object>();
  const requests = createReviewerRequestRegistry();
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
  let cachedPreferences: Promise<Preferences> | null = null;
  let latestDisplayPreferences: Preferences | null = null;
  const accountResolver = createSelfHealingAccountResolver();
  const fallbackAccounts = createFallbackAccountIntegration((owner) =>
    accountResolver.resolveFallbackAccount(owner, currentRoute?.repo ?? ""),
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
    onMeaningfulChange: requests.invalidate,
    onRowsChanged: () => outcomes.reconcile(collectVisiblePullNumbers()),
  });

  // After a primary rate limit is exhausted, later requests for the same
  // account would only be rejected. Until the reset time, rows of the same
  // generation settle with the recorded failure instead of being dispatched.
  // Navigation and account changes allocate a new generation and try again.
  let quotaBlock: {
    generation: number;
    accountId: string | null;
    until: number;
    failure: ReviewerFailure;
  } | null = null;
  function readQuotaBlock(
    rowGeneration: number,
    account: Account | null,
  ): ReviewerFailure | null {
    if (
      quotaBlock == null ||
      quotaBlock.generation !== rowGeneration ||
      quotaBlock.accountId !== (account?.id ?? null) ||
      Date.now() >= quotaBlock.until
    )
      return null;
    return quotaBlock.failure;
  }

  function abortInflightRequests(reopenDiscovery = true): void {
    generation += 1;
    quotaBlock = null;
    if (reopenDiscovery) {
      const previousDiscovery = discovery;
      discovery = undefined;
      activeDiscoveryGeneration = ++discoveryGeneration;
      void previousDiscovery
        ?.then((value) => retireRepositoryDiscovery(value.id))
        .catch(() => undefined);
    }
    requests.abortAll();
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

  async function processRow(row: Element): Promise<void> {
    if (!hydrated || disposed || currentRoute == null || !row.isConnected)
      return;

    const pullNumber = extractPullNumber(row);
    if (pullNumber == null) return;

    const mount = ensureReviewerMount(row);
    if (mount == null) return;

    const route = currentRoute;
    const cacheKey = buildReviewerCacheKey(route.owner, route.repo, pullNumber);
    let requestOwner = requests.ownerOf(cacheKey);
    const rowGeneration = generation;
    const operation = {};
    mountOperations.set(mount, operation);
    const isRowCurrent = () =>
      !disposed &&
      generation === rowGeneration &&
      currentRoute === route &&
      row.isConnected &&
      extractPullNumber(row) === pullNumber;
    const work: RowWork = {
      mount,
      route,
      pullNumber,
      cacheKey,
      generation: rowGeneration,
      isRowCurrent,
      isOperationCurrent: () =>
        isRowCurrent() &&
        row.contains(mount) &&
        mountOperations.get(mount) === operation &&
        requests.ownerOf(cacheKey) === requestOwner,
    };
    rowLifecycle.recordFingerprint(row, pullNumber, route);
    const cachedEntry = getReviewerCacheEntry(cacheKey);
    if (cachedEntry == null || !isReviewerCacheEntryFresh(cachedEntry))
      outcomes.pending(rowGeneration, pullNumber);
    if (cachedEntry != null) {
      await renderSummaryForMount(
        mount,
        route,
        cachedEntry.summary,
        work.isOperationCurrent,
      );
      if (!work.isOperationCurrent()) return;
      if (isReviewerCacheEntryFresh(cachedEntry)) {
        outcomes.cached(rowGeneration, pullNumber);
        return;
      }
    }

    const existingRequest = requests.get(cacheKey);
    if (existingRequest) {
      requestOwner = existingRequest.owner;
      await joinRequest(work, existingRequest);
      return;
    }

    if (cachedEntry == null && !mountHasRenderedChips(mount)) {
      showLoading(mount);
    }

    const request = requests.start(cacheKey, mount, isRowCurrent);
    requestOwner = request.owner;
    outcomes.begin(rowGeneration, pullNumber, request.owner);
    request.promise = runRequest(work, request);
    try {
      await request.promise;
    } catch {
      // Errors are handled inside the request pipeline.
    }

    if (!work.isOperationCurrent() || request.controller.signal.aborted) {
      return;
    }
    if (request.invalidated && request.succeeded) return;

    await renderSummaryForMount(
      mount,
      route,
      getReviewerCacheEntry(cacheKey)?.summary,
      work.isOperationCurrent,
    );
  }

  /** Attaches a row to the request another row already started for this PR. */
  async function joinRequest(
    work: RowWork,
    existing: ReviewerRequest,
  ): Promise<void> {
    const { mount, route, cacheKey } = work;
    outcomes.begin(work.generation, work.pullNumber, existing.owner);
    requests.join(existing, mount, work.isRowCurrent);
    const existingEntry = getReviewerCacheEntry(cacheKey);
    if (existingEntry != null) {
      await renderSummaryForMount(
        mount,
        route,
        existingEntry.summary,
        work.isOperationCurrent,
      );
      if (!work.isOperationCurrent()) return;
    } else if (!mountHasRenderedChips(mount)) {
      showLoading(mount);
    }
    try {
      await existing.promise;
    } catch {
      // The tracked request reports its own failure.
    }
    if (!work.isOperationCurrent() || existing.controller.signal.aborted) {
      return;
    }
    if (existing.invalidated && existing.succeeded) return;
    const settledSummary = getReviewerCacheEntry(cacheKey)?.summary;
    if (settledSummary == null) {
      clearReviewerMountWithoutCache(mount, cacheKey);
    } else {
      await renderSummaryForMount(
        mount,
        route,
        settledSummary,
        work.isOperationCurrent,
      );
    }
  }

  /** Discovery, account, page metadata, then the scheduled summary fetch. */
  async function runRequest(
    work: RowWork,
    request: ReviewerRequest,
  ): Promise<void> {
    const { mount, route, pullNumber, cacheKey } = work;
    const rowGeneration = work.generation;
    const { controller } = request;
    const isRequestCurrent = () => requests.isCurrent(cacheKey, request);
    const settleFailure = (failure: ReviewerFailure): void => {
      if (work.isOperationCurrent())
        clearReviewerMountWithoutCache(mount, cacheKey);
      outcomes.settle(rowGeneration, pullNumber, request.owner, {
        status: "failure",
        failure,
      });
    };
    let account: Account | null = null;
    try {
      const repositoryDiscovery = await getDiscovery(route);
      if (!isRequestCurrent()) return;
      account = await accountResolver.resolveAccount(route.owner, route.repo);
      if (!isRequestCurrent()) {
        return;
      }
      const blocked = readQuotaBlock(rowGeneration, account);
      if (blocked) throw new QuotaBlockedSkip(blocked);
      const metadataResult = await pageMetadata.get({
        route,
        account,
        targetPullNumbers: collectVisiblePullNumbers(),
        signal: controller.signal,
        discoveryId: repositoryDiscovery.id,
      });
      if (!isRequestCurrent()) {
        return;
      }
      if (metadataResult.failure?.suppressRowFallback) {
        // One failure identity is shared by every row the batch suppressed.
        settleFailure(metadataResult.failure);
        return;
      }
      const pullMetadata = metadataResult.metadata.get(pullNumber);
      const summaryAccount =
        metadataResult.account === undefined ? account : metadataResult.account;
      let actualSummaryAccount = summaryAccount;
      if (!isRequestCurrent()) {
        return;
      }

      try {
        const summary = await reviewerSummaryScheduler.run(() => {
          if (!isRequestCurrent()) controller.abort();
          const blocked = readQuotaBlock(rowGeneration, summaryAccount);
          if (blocked) throw new QuotaBlockedSkip(blocked);
          return fetchReviewerSummary({
            account: summaryAccount,
            owner: route.owner,
            repo: route.repo,
            pullNumber,
            signal: controller.signal,
            discoveryId: repositoryDiscovery.id,
            onAccount: (actual) => {
              account = actual;
              actualSummaryAccount = actual;
            },
            ...(pullMetadata == null ? {} : { pullMetadata }),
          });
        }, controller.signal);
        if (!isRequestCurrent()) {
          return;
        }
        setCachedReviewerSummary(cacheKey, summary);
        if (request.invalidated) markReviewerCacheStale(cacheKey);
        request.succeeded = true;
        if (!request.invalidated)
          outcomes.settle(rowGeneration, pullNumber, request.owner, {
            status: "success",
          });
      } catch (error) {
        if (isAbortError(error) || !isRequestCurrent()) {
          return;
        }
        if (error instanceof QuotaBlockedSkip) throw error;
        const failureAccount =
          error instanceof ReviewerFetchRuntimeError &&
          error.account !== undefined
            ? error.account
            : actualSummaryAccount;
        const failure: ReviewerFailure = { account: failureAccount, error };
        const quotaReset = readPrimaryRateLimitReset(error);
        if (quotaReset != null && rowGeneration === generation)
          quotaBlock = {
            generation: rowGeneration,
            accountId: failureAccount?.id ?? null,
            until: quotaReset,
            failure,
          };
        settleFailure(failure);
      }
    } catch (error) {
      if (isAbortError(error) || !isRequestCurrent()) {
        return;
      }
      // A skipped row shares the failure that exhausted the quota, so the
      // banner aggregates one failure identity for all of them.
      settleFailure(
        error instanceof QuotaBlockedSkip ? error.failure : { account, error },
      );
    } finally {
      if (
        requests.release(cacheKey, request) &&
        request.succeeded &&
        request.invalidated
      )
        void revalidateLiveConsumers(cacheKey, request);
    }
  }

  // The old result remains stale. Revalidate once after its slot and per-PR
  // request ownership are released, using current page metadata.
  async function revalidateLiveConsumers(
    cacheKey: CacheKey,
    request: ReviewerRequest,
  ): Promise<void> {
    const liveRows = new Set(
      requests
        .liveConsumers(request)
        .map((consumerMount) => consumerMount.closest(githubSelectors.row))
        .filter((liveRow): liveRow is Element => liveRow != null),
    );
    let attempted = false;
    for (const liveRow of liveRows) {
      if (!liveRow.isConnected) continue;
      // Another dirty follow-up may already own this PR. A failed attempt must
      // not make duplicate consumers start a retry loop.
      const entry = getReviewerCacheEntry(cacheKey);
      if (
        attempted &&
        requests.get(cacheKey) == null &&
        (entry == null || !isReviewerCacheEntryFresh(entry))
      )
        break;
      attempted = true;
      await processRow(liveRow);
    }
  }

  // Several events can report one navigation. Only `applyRouteChange`
  // allocates a page generation for them, once per navigation.
  let settleTicksLeft = 0;
  let renderHandled = false;

  function applyRouteChange(): void {
    currentHref = window.location.href;
    const previousRoute = currentRoute;
    currentRoute = parsePullListRoute(window.location.pathname);
    abortInflightRequests();
    syncLocaleSubscription();
    rowLifecycle.syncObservation();

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
  }

  /** URL-driven refresh: a committed location change, popstate or the poll. */
  function refreshLocation(): void {
    if (disposed || window.location.href === currentHref) return;
    applyRouteChange();
    // The DOM may still show the page being left, so its rows are not
    // reprocessed here. Rows GitHub renders for the new page are processed as
    // they are added; rows it leaves in place wait for a render event or for
    // one full poll interval.
    settleTicksLeft = currentRoute == null ? 0 : NAVIGATION_SETTLE_TICKS;
  }

  /** Render-driven refresh: the DOM now belongs to the current URL. */
  function refreshRendered(): void {
    if (disposed) return;
    const navigated = window.location.href !== currentHref;
    if (!navigated && renderHandled) return;
    // A render that completes an already counted navigation reuses its
    // generation; a same-URL render is a revalidation trigger of its own.
    if (navigated || settleTicksLeft === 0) applyRouteChange();
    settleTicksLeft = 0;
    if (!renderHandled) {
      // GitHub can dispatch more than one render event for the same render.
      renderHandled = true;
      queueMicrotask(() => {
        renderHandled = false;
      });
    }
    rowLifecycle.processRows();
  }

  function pollRoute(): void {
    if (disposed) return;
    if (window.location.href !== currentHref) {
      refreshLocation();
      return;
    }
    if (settleTicksLeft > 0 && --settleTicksLeft === 0)
      rowLifecycle.processRows();
  }

  const observer = rowLifecycle.observe();
  function hydrate(snapshot: UISnapshot): void {
    // A reconnect can deliver the first usable snapshot after read() failed.
    // Once subscribed state wins, a delayed initial read must not replace it.
    if (disposed || hydrated) return;
    hydrated = true;
    latestDisplayPreferences = snapshot.preferences;
    cachedPreferences = Promise.resolve(snapshot.preferences);
    rowLifecycle.processRows();
  }

  // WXT dispatches `wxt:locationchange` from the Navigation API's `navigate`
  // event, which fires before the URL commits. Read the location afterwards.
  ctx.addEventListener(window, "wxt:locationchange", () =>
    queueMicrotask(refreshLocation),
  );
  ctx.addEventListener(window, "popstate", refreshLocation);
  ctx.addEventListener(document, "turbo:render", refreshRendered);
  ctx.addEventListener(document, "pjax:end", refreshRendered);

  const unsubscribeState = getUIClient().subscribe(({ snapshot, previous }) => {
    if (disposed) return;
    if (!hydrated) {
      hydrate(snapshot);
      return;
    }
    const next = snapshot.preferences;
    const before = previous?.preferences;
    const displayChanged =
      !before ||
      before.showStateBadge !== next.showStateBadge ||
      before.showReviewerName !== next.showReviewerName ||
      before.openPullsOnly !== next.openPullsOnly;
    latestDisplayPreferences = next;
    cachedPreferences = Promise.resolve(next);
    if (previous && previous.accountsRevision !== snapshot.accountsRevision) {
      clearReviewerCache();
      fallbackAccounts.clear();
      // A terminal refresh can invalidate its account. Clear obsolete UI work
      // without laundering the same 401 into a fresh search through B/C.
      abortInflightRequests(
        previous.discoveryRevision === undefined ||
          previous.discoveryRevision !== snapshot.discoveryRevision,
      );
      rowLifecycle.processRows();
    } else if (displayChanged) renderDisplay(next);
  });
  void getUIClient()
    .read()
    .then(hydrate, () => undefined);

  ctx.setInterval(pollRoute, 1000);
  ctx.onInvalidated(() => {
    disposed = true;
    observer.disconnect();
    unsubscribeLocale?.();
    unsubscribeLocale = undefined;
    unsubscribeState();
    abortInflightRequests();
  });

  function clearReviewerMountWithoutCache(
    mount: HTMLElement,
    cacheKey: CacheKey,
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
