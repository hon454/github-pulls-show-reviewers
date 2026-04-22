import type { ContentScriptContext } from "wxt/utils/content-script-context";

import {
  buildReviewerCacheKey,
  clearReviewerCache,
  getCachedReviewerSummary,
  setCachedReviewerSummary,
} from "../../cache/reviewer-cache";
import { fetchPullReviewerSummary } from "../../github/api";
import { parsePullListRoute } from "../../github/routes";
import { githubSelectors } from "../../github/selectors";
import { markAccountInvalidated, resolveAccountForRepo, type Account } from "../../storage/accounts";
import {
  DEFAULT_PREFERENCES,
  getPreferences,
  isAccountsChange,
  isPreferencesChange,
  type Preferences,
} from "../../storage/preferences";

import {
  ensureReviewerMount,
  ensureReviewerStyles,
  extractPullNumber,
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
  const inflightRequests = new Map<string, Promise<void>>();
  let cachedPreferences: Promise<Preferences> | null = null;

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
      renderLoading(mount);
      await existingRequest;
      await renderSummaryForMount(mount, route, getCachedReviewerSummary(cacheKey));
      return;
    }

    renderLoading(mount);

    const request = (async () => {
      const account = await resolveAccountForRepo(route.owner, route.repo);
      const githubToken = account?.token ?? null;

      try {
        const summary = await fetchPullReviewerSummary({
          owner: route.owner,
          repo: route.repo,
          pullNumber,
          githubToken,
        });
        setCachedReviewerSummary(cacheKey, summary);
      } catch (error) {
        const invalidationReason =
          account == null ? null : getAccountInvalidationReason(error);
        if (account != null && invalidationReason != null) {
          await markAccountInvalidated(account.id, invalidationReason);
        }
        mount.replaceChildren();
        mount.removeAttribute("title");
        options?.onRowFailure?.({
          owner: route.owner,
          repo: route.repo,
          account,
          error,
        });
      } finally {
        inflightRequests.delete(cacheKey);
      }
    })();

    inflightRequests.set(cacheKey, request);
    await request;

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

function getAccountInvalidationReason(
  error: unknown,
): "revoked" | "expired" | "unknown" | null {
  return extractStatus(error) === 401 ? "revoked" : null;
}

function extractStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const value = (error as { status: unknown }).status;
    return typeof value === "number" ? value : null;
  }

  if (
    error &&
    typeof error === "object" &&
    "failures" in error &&
    Array.isArray((error as { failures: unknown }).failures)
  ) {
    const first = (error as { failures: Array<{ status?: number }> })
      .failures[0];
    return typeof first?.status === "number" ? first.status : null;
  }

  return null;
}
