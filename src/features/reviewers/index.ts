import type { ContentScriptContext } from "wxt/utils/content-script-context";

import {
  buildReviewerCacheKey,
  clearReviewerCache,
  getCachedReviewerSummary,
  setCachedReviewerSummary,
} from "../../cache/reviewer-cache";
import type { PullReviewerSummary } from "../../github/api";
import { parsePullListRoute } from "../../github/routes";
import { githubSelectors } from "../../github/selectors";
import {
  ReviewerFetchRuntimeError,
  type FetchPullReviewerSummaryResponse,
} from "../../runtime/reviewer-fetch";
import { resolveAccountForRepo, type Account } from "../../storage/accounts";
import {
  DEFAULT_PREFERENCES,
  getPreferences,
  isAccountsChange,
  isPreferencesChange,
  type Preferences,
} from "../../storage/preferences";

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

  function abortInflightRequests(): void {
    for (const request of inflightRequests.values()) {
      request.controller.abort();
    }
    inflightRequests.clear();
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
    summary: ReturnType<typeof getCachedReviewerSummary>,
  ): Promise<void> {
    if (!summary) return;
    const preferences = await readPreferences();
    renderReviewers(mount, buildReviewers(route, summary), {
      showStateBadge: preferences.showStateBadge,
      showReviewerName: preferences.showReviewerName,
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
    const cachedSummary = getCachedReviewerSummary(cacheKey);
    if (cachedSummary) {
      await renderSummaryForMount(mount, route, cachedSummary);
      return;
    }

    const existingRequest = inflightRequests.get(cacheKey);
    if (existingRequest) {
      // Option (a): if another caller already cached the summary for this
      // key, render it immediately instead of flashing the loading text.
      // This also covers the race where the cache has just been set but the
      // inflight entry has not been deleted yet.
      const existingSummary = getCachedReviewerSummary(cacheKey);
      if (existingSummary) {
        await renderSummaryForMount(mount, route, existingSummary);
      } else if (!mountHasRenderedChips(mount)) {
        renderLoading(mount);
      }
      try {
        await existingRequest.promise;
      } catch {
        // Existing request errors are reported via its own onRowFailure; swallow here.
      }
      await renderSummaryForMount(mount, route, getCachedReviewerSummary(cacheKey));
      return;
    }

    if (!mountHasRenderedChips(mount)) {
      renderLoading(mount);
    }

    const controller = new AbortController();
    let request: InflightRequest | null = null;
    const promise = (async () => {
      const account = await resolveAccountForRepo(route.owner, route.repo);

      try {
        const summary = await fetchWithRefresh({
          account,
          owner: route.owner,
          repo: route.repo,
          pullNumber,
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

    await renderSummaryForMount(mount, route, getCachedReviewerSummary(cacheKey));
  }

  function processRows(root: ParentNode = document): void {
    if (currentRoute == null) return;
    root.querySelectorAll(githubSelectors.row).forEach((row) => {
      void processRow(row);
    });
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
    }

    processRows();
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node.matches(githubSelectors.row)) {
          void processRow(node);
          return;
        }
        processRows(node);
      });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  processRows();

  ctx.addEventListener(window, "wxt:locationchange", () => refreshRoute(true));
  ctx.addEventListener(window, "popstate", () => refreshRoute(true));
  ctx.addEventListener(document, "turbo:render", () => refreshRoute(true));
  ctx.addEventListener(document, "pjax:end", () => refreshRoute(true));

  const storageListener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
    changes,
    areaName,
  ) => {
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

async function fetchWithRefresh(args: {
  account: Account | null;
  owner: string;
  repo: string;
  pullNumber: string;
  signal?: AbortSignal;
}): Promise<PullReviewerSummary> {
  const { account, owner, repo, pullNumber, signal } = args;

  if (signal?.aborted) {
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
  }) as Promise<FetchPullReviewerSummaryResponse | undefined>;

  if (signal == null) {
    return unwrapReviewerFetchResponse(await responsePromise);
  }

  let removeAbortListener: (() => void) | null = null;
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

    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    const response = await Promise.race([responsePromise, abortPromise]);
    return unwrapReviewerFetchResponse(response);
  } finally {
    const cleanup = removeAbortListener as (() => void) | null;
    if (cleanup != null) {
      cleanup();
    }
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

let reviewerFetchRequestCounter = 0;

function createReviewerFetchRequestId(): string {
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
