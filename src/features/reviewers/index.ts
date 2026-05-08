import type { ContentScriptContext } from "wxt/utils/content-script-context";

import {
  buildReviewerCacheKey,
  clearReviewerCache,
  getReviewerCacheEntry,
  isReviewerCacheEntryFresh,
  markReviewerCacheStale,
  markReviewerCacheStaleForRepository,
  setCachedReviewerSummary,
} from "../../cache/reviewer-cache";
import type {
  PullReviewerMetadata,
  PullReviewerSummary,
} from "../../github/api";
import { parsePullListRoute } from "../../github/routes";
import { githubSelectors } from "../../github/selectors";
import type { RefreshAccountInstallationsResponse } from "../../runtime/installation-refresh";
import {
  ReviewerFetchRuntimeError,
  type FetchPullReviewerMetadataBatchResponse,
  type FetchPullReviewerSummaryResponse,
} from "../../runtime/reviewer-fetch";
import { type Account } from "../../storage/accounts";
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
import { buildReviewers } from "./view-model";

const PAGE_METADATA_FRESH_MS = 10_000;

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
  type PageMetadataRequest = {
    owner: string;
    repo: string;
    accountId: string | null;
    promise: Promise<Map<string, PullReviewerMetadata>>;
    controller: AbortController;
  };
  type PageMetadataCache = {
    owner: string;
    repo: string;
    accountId: string | null;
    metadata: Map<string, PullReviewerMetadata>;
    fetchedAt: number;
    stale: boolean;
  };
  const inflightRequests = new Map<string, InflightRequest>();
  const rowFingerprints = new Map<string, string>();
  let pageMetadataRequest: PageMetadataRequest | null = null;
  let pageMetadataCache: PageMetadataCache | null = null;
  let cachedPreferences: Promise<Preferences> | null = null;
  const accountResolver = createSelfHealingAccountResolver({
    requestRefresh: requestInstallationsRefresh,
  });

  function abortInflightRequests(): void {
    for (const request of inflightRequests.values()) {
      request.controller.abort();
    }
    inflightRequests.clear();
    pageMetadataRequest?.controller.abort();
    pageMetadataRequest = null;
    pageMetadataCache = null;
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

  async function getPageMetadata(
    route: NonNullable<typeof currentRoute>,
    account: Account | null,
    signal: AbortSignal,
  ): Promise<Map<string, PullReviewerMetadata>> {
    const accountId = account?.id ?? null;
    if (
      pageMetadataCache != null &&
      pageMetadataCache.owner === route.owner &&
      pageMetadataCache.repo === route.repo &&
      pageMetadataCache.accountId === accountId &&
      !pageMetadataCache.stale &&
      Date.now() - pageMetadataCache.fetchedAt <= PAGE_METADATA_FRESH_MS
    ) {
      return pageMetadataCache.metadata;
    }

    if (
      pageMetadataRequest != null &&
      pageMetadataRequest.owner === route.owner &&
      pageMetadataRequest.repo === route.repo &&
      pageMetadataRequest.accountId === accountId
    ) {
      return pageMetadataRequest.promise;
    }

    const controller = new AbortController();
    signal.addEventListener(
      "abort",
      () => {
        controller.abort();
      },
      { once: true },
    );

    const request: PageMetadataRequest = {
      owner: route.owner,
      repo: route.repo,
      accountId,
      controller,
      promise: fetchPageMetadata({
        account,
        owner: route.owner,
        repo: route.repo,
        signal: controller.signal,
      })
        .then((metadata) => {
          const metadataByNumber = new Map(
            metadata.map((pullMetadata) => [pullMetadata.number, pullMetadata]),
          );
          pageMetadataCache = {
            owner: route.owner,
            repo: route.repo,
            accountId,
            metadata: metadataByNumber,
            fetchedAt: Date.now(),
            stale: false,
          };
          return metadataByNumber;
        })
        .catch((error) => {
          if (!isAbortError(error) && !controller.signal.aborted) {
            pageMetadataCache = {
              owner: route.owner,
              repo: route.repo,
              accountId,
              metadata: new Map(),
              fetchedAt: Date.now(),
              stale: false,
            };
          }
          return new Map<string, PullReviewerMetadata>();
        })
        .finally(() => {
          if (pageMetadataRequest === request) {
            pageMetadataRequest = null;
          }
        }),
    };
    pageMetadataRequest = request;
    return request.promise;
  }

  async function processRow(row: Element): Promise<void> {
    if (currentRoute == null) return;

    const pullNumber = extractPullNumber(row);
    if (pullNumber == null) return;

    const mount = ensureReviewerMount(row);
    if (mount == null) return;

    const route = currentRoute;
    const cacheKey = buildReviewerCacheKey(route.owner, route.repo, pullNumber);
    rowFingerprints.set(cacheKey, createRowFingerprint(row, pullNumber));
    const cachedEntry = getReviewerCacheEntry(cacheKey);
    if (cachedEntry != null) {
      await renderSummaryForMount(mount, route, cachedEntry.summary);
      if (isReviewerCacheEntryFresh(cachedEntry)) {
        return;
      }
    }

    const existingRequest = inflightRequests.get(cacheKey);
    if (existingRequest) {
      // Option (a): if another caller already cached the summary for this
      // key, render it immediately instead of flashing the loading text.
      // This also covers the race where the cache has just been set but the
      // inflight entry has not been deleted yet.
      const existingEntry = getReviewerCacheEntry(cacheKey);
      if (existingEntry != null) {
        await renderSummaryForMount(mount, route, existingEntry.summary);
      } else if (!mountHasRenderedChips(mount)) {
        renderLoading(mount);
      }
      try {
        await existingRequest.promise;
      } catch {
        // Existing request errors are reported via its own onRowFailure; swallow here.
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
      const pullMetadata = (
        await getPageMetadata(route, account, controller.signal)
      ).get(pullNumber);
      if (controller.signal.aborted) {
        return;
      }

      try {
        const summary = await fetchWithRefresh({
          account,
          owner: route.owner,
          repo: route.repo,
          pullNumber,
          pullMetadata,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        setCachedReviewerSummary(cacheKey, summary);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          return;
        }
        mount.replaceChildren();
        mount.removeAttribute("title");
        clearRenderedReviewerState(mount);
        options?.onRowFailure?.({
          owner: route.owner,
          repo: route.repo,
          account,
          error,
        });
      } finally {
        // Only delete if this is still the tracked request for that key.
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
      // Errors are handled inside the async block; nothing to do here.
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

  function processRows(root: ParentNode = document): void {
    if (currentRoute == null) return;
    root.querySelectorAll(githubSelectors.row).forEach((row) => {
      void processRow(row);
    });
  }

  function processMutatedRow(target: Node): void {
    if (currentRoute == null) return;
    const element = target instanceof Element ? target : target.parentElement;
    if (element == null || element.closest("[data-ghpsr-root]") != null) {
      return;
    }
    const row = element.closest(githubSelectors.row);
    if (row == null) return;
    const pullNumber = extractPullNumber(row);
    if (pullNumber == null) return;
    const cacheKey = buildReviewerCacheKey(
      currentRoute.owner,
      currentRoute.repo,
      pullNumber,
    );
    const nextFingerprint = createRowFingerprint(row, pullNumber);
    const previousFingerprint = rowFingerprints.get(cacheKey);
    rowFingerprints.set(cacheKey, nextFingerprint);
    if (previousFingerprint === nextFingerprint) {
      return;
    }
    markReviewerCacheStale(cacheKey);
    pageMetadataCache =
      pageMetadataCache == null ? null : { ...pageMetadataCache, stale: true };
    void processRow(row);
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
      rowFingerprints.clear();
    } else if (currentRoute != null) {
      markReviewerCacheStaleForRepository(
        currentRoute.owner,
        currentRoute.repo,
      );
    }

    processRows();
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList" || mutation.addedNodes.length === 0) {
        processMutatedRow(mutation.target);
        continue;
      }
      processMutatedRow(mutation.target);
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node.closest("[data-ghpsr-root]") != null) return;
        if (node.matches(githubSelectors.row)) {
          void processRow(node);
          return;
        }
        processRows(node);
      });
    }
  });

  observer.observe(document.body, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  processRows();

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
      processRows();
      return;
    }

    if (isAccountsChange(changes)) {
      clearReviewerCache();
      abortInflightRequests();
      processRows();
    }
  };

  browser.storage.onChanged.addListener(storageListener);
  ctx.setInterval(() => refreshRoute(), 1000);
  ctx.onInvalidated(() => {
    observer.disconnect();
    browser.storage.onChanged.removeListener(storageListener);
  });
}

function createRowFingerprint(row: Element, pullNumber: string): string {
  const link = row.querySelector<HTMLAnchorElement>(
    githubSelectors.primaryLink,
  );
  const href = link?.getAttribute("href") ?? "";
  const metaContainer = findFirst(row, githubSelectors.metaContainers);
  return [pullNumber, href, readRowMetadataText(metaContainer)].join("|");
}

function findFirst(
  root: ParentNode,
  selectors: readonly string[],
): Element | null {
  for (const selector of selectors) {
    const match = root.querySelector(selector);
    if (match != null) return match;
  }
  return null;
}

function readRowMetadataText(metaContainer: Element | null): string {
  if (metaContainer == null) return "";
  const clone = metaContainer.cloneNode(true);
  if (!(clone instanceof Element)) return "";
  clone
    .querySelectorAll(
      [
        "[data-ghpsr-root]",
        ...githubSelectors.volatileMetadataSelectors,
      ].join(", "),
    )
    .forEach((node) => node.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function fetchWithRefresh(args: {
  account: Account | null;
  owner: string;
  repo: string;
  pullNumber: string;
  pullMetadata?: PullReviewerMetadata;
  signal: AbortSignal;
}): Promise<PullReviewerSummary> {
  const { account, owner, repo, pullNumber, pullMetadata, signal } = args;

  if (signal.aborted) {
    throw createAbortError();
  }

  const requestId = createReviewerFetchRequestId();
  const responsePromise = browser.runtime.sendMessage({
    type: "fetchPullReviewerSummary",
    requestId,
    owner,
    repo,
    pullNumber,
    accountId: account?.id ?? null,
    ...(pullMetadata == null ? {} : { pullMetadata }),
  }) as Promise<FetchPullReviewerSummaryResponse | undefined>;

  const abortListenerController = new AbortController();
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      void browser.runtime
        .sendMessage({
          type: "cancelPullReviewerSummary",
          requestId,
        })
        .catch(() => undefined);
      reject(createAbortError());
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, {
      once: true,
      signal: abortListenerController.signal,
    });
  });

  try {
    const response = await Promise.race([responsePromise, abortPromise]);
    return unwrapReviewerFetchResponse(response);
  } finally {
    abortListenerController.abort();
  }
}

async function fetchPageMetadata(args: {
  account: Account | null;
  owner: string;
  repo: string;
  signal: AbortSignal;
}): Promise<PullReviewerMetadata[]> {
  const { account, owner, repo, signal } = args;

  if (signal.aborted) {
    throw createAbortError();
  }

  const requestId = createReviewerFetchRequestId();
  const responsePromise = browser.runtime.sendMessage({
    type: "fetchPullReviewerMetadataBatch",
    requestId,
    owner,
    repo,
    accountId: account?.id ?? null,
  }) as Promise<FetchPullReviewerMetadataBatchResponse | undefined>;

  const abortListenerController = new AbortController();
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      void browser.runtime
        .sendMessage({
          type: "cancelPullReviewerSummary",
          requestId,
        })
        .catch(() => undefined);
      reject(createAbortError());
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, {
      once: true,
      signal: abortListenerController.signal,
    });
  });

  try {
    const response = await Promise.race([responsePromise, abortPromise]);
    return unwrapReviewerMetadataBatchResponse(response);
  } finally {
    abortListenerController.abort();
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (
    error != null &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  ) {
    return true;
  }
  return false;
}

function unwrapReviewerFetchResponse(
  response: FetchPullReviewerSummaryResponse | undefined,
): PullReviewerSummary {
  if (response?.ok === true) {
    return response.summary;
  }

  if (response?.ok === false) {
    throw new ReviewerFetchRuntimeError(response.error);
  }

  throw new Error("Background reviewer fetch failed.");
}

function unwrapReviewerMetadataBatchResponse(
  response: FetchPullReviewerMetadataBatchResponse | undefined,
): PullReviewerMetadata[] {
  if (response?.ok === true) {
    return response.metadata;
  }

  if (response?.ok === false) {
    throw new ReviewerFetchRuntimeError(response.error);
  }

  throw new Error("Background reviewer metadata fetch failed.");
}

let reviewerFetchRequestCounter = 0;

function createReviewerFetchRequestId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `reviewer-fetch-${globalThis.crypto.randomUUID()}`;
  }

  reviewerFetchRequestCounter += 1;
  return `reviewer-fetch-${Date.now()}-${reviewerFetchRequestCounter}`;
}

function createAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }

  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

async function requestInstallationsRefresh(
  accountId: string,
): Promise<boolean> {
  try {
    const response = (await browser.runtime.sendMessage({
      type: "refreshAccountInstallations",
      accountId,
    })) as RefreshAccountInstallationsResponse;
    return response?.ok === true;
  } catch {
    return false;
  }
}
