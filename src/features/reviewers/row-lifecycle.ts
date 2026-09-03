import {
  buildReviewerCacheKey,
  markReviewerCacheStale,
} from "../../cache/reviewer-cache";
import type { PullListRoute } from "../../github/routes";
import { githubSelectors } from "../../github/selectors";

import { extractPullNumber } from "./dom";

export type ReviewerRowLifecycle = {
  recordFingerprint(
    row: Element,
    pullNumber: string,
    route: PullListRoute,
  ): void;
  processRows(root?: ParentNode): void;
  clearFingerprints(): void;
  observe(): MutationObserver;
};

/** Optional local work counters for deterministic tests; no data is emitted. */
export type ReviewerRowLifecycleDiagnostics = {
  onObserverCallback?: (mutationCount: number) => void;
  onFingerprint?: () => void;
  onProcessRow?: () => void;
};

export function createReviewerRowLifecycle(input: {
  getRoute: () => PullListRoute | null;
  processRow: (row: Element) => void | Promise<void>;
  markPageMetadataStale: () => void;
  diagnostics?: ReviewerRowLifecycleDiagnostics;
}): ReviewerRowLifecycle {
  const rowFingerprints = new Map<string, string>();

  function recordFingerprint(
    row: Element,
    pullNumber: string,
    route: PullListRoute,
  ): void {
    const cacheKey = buildReviewerCacheKey(route.owner, route.repo, pullNumber);
    input.diagnostics?.onFingerprint?.();
    rowFingerprints.set(cacheKey, createRowFingerprint(row, pullNumber));
  }

  function processRow(row: Element): void {
    input.diagnostics?.onProcessRow?.();
    void input.processRow(row);
  }

  function processRows(root: ParentNode = document): void {
    if (input.getRoute() == null) return;
    root.querySelectorAll(githubSelectors.row).forEach((row) => {
      processRow(row);
    });
  }

  function processMutatedRow(target: Node): void {
    const route = input.getRoute();
    if (route == null) return;
    const row = findMutationRow(target);
    if (row == null) return;
    const pullNumber = extractPullNumber(row);
    if (pullNumber == null) return;
    const cacheKey = buildReviewerCacheKey(route.owner, route.repo, pullNumber);
    input.diagnostics?.onFingerprint?.();
    const nextFingerprint = createRowFingerprint(row, pullNumber);
    const previousFingerprint = rowFingerprints.get(cacheKey);
    rowFingerprints.set(cacheKey, nextFingerprint);
    if (previousFingerprint === nextFingerprint) {
      return;
    }
    markReviewerCacheStale(cacheKey);
    input.markPageMetadataStale();
    processRow(row);
  }

  function observe(): MutationObserver {
    const observer = new MutationObserver((mutations) => {
      input.diagnostics?.onObserverCallback?.(mutations.length);
      const addedRows = new Set<Element>();
      const mutatedRows = new Set<Element>();

      for (const mutation of mutations) {
        if (mutation.type !== "childList") {
          const row = findMutationRow(mutation.target);
          if (row != null) mutatedRows.add(row);
          continue;
        }

        if (isFingerprintExcludedNode(mutation.target)) continue;
        const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
        if (changedNodes.some((node) => !isFingerprintExcludedNode(node))) {
          const row = findMutationRow(mutation.target);
          if (row != null) mutatedRows.add(row);
        }

        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (isFingerprintExcludedNode(node)) return;
          collectRows(node, addedRows);
        });
      }

      for (const row of addedRows) {
        mutatedRows.delete(row);
        processRow(row);
      }
      for (const row of mutatedRows) {
        processMutatedRow(row);
      }
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: [...githubSelectors.observedRowAttributes],
      childList: true,
      characterData: true,
      subtree: true,
    });
    return observer;
  }

  return {
    recordFingerprint,
    processRows,
    clearFingerprints(): void {
      rowFingerprints.clear();
    },
    observe,
  };
}

function collectRows(root: Element, rows: Set<Element>): void {
  if (root.matches(githubSelectors.row)) rows.add(root);
  root.querySelectorAll(githubSelectors.row).forEach((row) => rows.add(row));
}

function findMutationRow(target: Node): Element | null {
  const element = target instanceof Element ? target : target.parentElement;
  if (element == null || isFingerprintExcludedNode(element)) return null;
  return element.closest(githubSelectors.row);
}

function isFingerprintExcludedNode(target: Node): boolean {
  const element = target instanceof Element ? target : target.parentElement;
  if (element == null) return false;
  return (
    element.closest("[data-ghpsr-root]") != null ||
    element.closest(githubSelectors.volatileMetadataSelectors.join(", ")) !=
      null
  );
}

export function collectVisiblePullNumbers(): string[] {
  const pullNumbers: string[] = [];
  const seen = new Set<string>();
  document.querySelectorAll(githubSelectors.row).forEach((row) => {
    const pullNumber = extractPullNumber(row);
    if (pullNumber == null || seen.has(pullNumber)) {
      return;
    }
    seen.add(pullNumber);
    pullNumbers.push(pullNumber);
  });
  return pullNumbers;
}

function createRowFingerprint(row: Element, pullNumber: string): string {
  const link = findFirst<HTMLAnchorElement>(
    row,
    githubSelectors.pullLinkSelectors,
  );
  const href = link?.getAttribute("href") ?? "";
  const metaContainer = findFirst(row, githubSelectors.metaContainers);
  return [pullNumber, href, readRowMetadataText(metaContainer)].join("|");
}

function findFirst<T extends Element = Element>(
  root: ParentNode,
  selectors: readonly string[],
): T | null {
  for (const selector of selectors) {
    const match = root.querySelector<T>(selector);
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
      ["[data-ghpsr-root]", ...githubSelectors.volatileMetadataSelectors].join(
        ", ",
      ),
    )
    .forEach((node) => node.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}
