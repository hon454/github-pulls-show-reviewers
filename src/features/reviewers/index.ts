import type { ContentScriptContext } from "wxt/utils/content-script-context";

import {
  buildReviewerCacheKey,
  clearReviewerCache,
  getCachedReviewerSummary,
  setCachedReviewerSummary,
} from "../../cache/reviewer-cache";
import { fetchPullReviewerSummary, describeGitHubApiError } from "../../github/api";
import { parsePullListRoute } from "../../github/routes";
import { githubSelectors } from "../../github/selectors";
import { getStoredSettings, type ExtensionSettings } from "../../storage/settings";

import {
  ensureReviewerMount,
  ensureReviewerStyles,
  extractPullNumber,
  renderError,
  renderLoading,
  renderReviewerSections,
} from "./dom";
import { buildReviewerSections } from "./view-model";

export function bootReviewerListPage(ctx: ContentScriptContext): void {
  ensureReviewerStyles();

  let currentRoute = parsePullListRoute(window.location.pathname);
  let currentHref = window.location.href;
  let settingsCache: ExtensionSettings | null = null;
  const inflightRequests = new Map<string, Promise<void>>();

  async function loadSettings(): Promise<ExtensionSettings> {
    if (settingsCache == null) {
      settingsCache = await getStoredSettings();
    }

    return settingsCache;
  }

  async function processRow(row: Element): Promise<void> {
    if (currentRoute == null) {
      return;
    }

    const pullNumber = extractPullNumber(row);
    if (pullNumber == null) {
      return;
    }

    const mount = ensureReviewerMount(row);
    if (mount == null) {
      return;
    }

    const cacheKey = buildReviewerCacheKey(currentRoute.owner, currentRoute.repo, pullNumber);
    const cachedSummary = getCachedReviewerSummary(cacheKey);
    if (cachedSummary) {
      renderReviewerSections(mount, buildReviewerSections(currentRoute, cachedSummary));
      return;
    }

    const existingRequest = inflightRequests.get(cacheKey);
    if (existingRequest) {
      renderLoading(mount);
      await existingRequest;
      const summary = getCachedReviewerSummary(cacheKey);
      if (summary && currentRoute) {
        renderReviewerSections(mount, buildReviewerSections(currentRoute, summary));
      }
      return;
    }

    renderLoading(mount);

    const request = (async () => {
      const settings = await loadSettings();

      try {
        const summary = await fetchPullReviewerSummary({
          owner: currentRoute!.owner,
          repo: currentRoute!.repo,
          pullNumber,
          settings,
        });
        setCachedReviewerSummary(cacheKey, summary);
      } catch (error) {
        renderError(mount, describeGitHubApiError(error, settings));
      } finally {
        inflightRequests.delete(cacheKey);
      }
    })();

    inflightRequests.set(cacheKey, request);
    await request;

    const summary = getCachedReviewerSummary(cacheKey);
    if (summary && currentRoute) {
      renderReviewerSections(mount, buildReviewerSections(currentRoute, summary));
    }
  }

  function processRows(root: ParentNode = document): void {
    if (currentRoute == null) {
      return;
    }

    root.querySelectorAll(githubSelectors.row).forEach((row) => {
      void processRow(row);
    });
  }

  function refreshRoute(force = false): void {
    const nextHref = window.location.href;
    if (!force && nextHref === currentHref) {
      return;
    }

    currentHref = nextHref;
    const previousRoute = currentRoute;
    currentRoute = parsePullListRoute(window.location.pathname);

    if (
      previousRoute &&
      currentRoute &&
      (previousRoute.owner !== currentRoute.owner || previousRoute.repo !== currentRoute.repo)
    ) {
      clearReviewerCache();
      inflightRequests.clear();
    }

    processRows();
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) {
          return;
        }

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
    if (areaName === "local" && changes.settings) {
      settingsCache = null;
      clearReviewerCache();
      inflightRequests.clear();
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
