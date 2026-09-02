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

export function createReviewerRowLifecycle(input: {
  getRoute: () => PullListRoute | null;
  processRow: (row: Element) => void | Promise<void>;
  markPageMetadataStale: () => void;
}): ReviewerRowLifecycle {
  const rowFingerprints = new Map<string, string>();

  function recordFingerprint(
    row: Element,
    pullNumber: string,
    route: PullListRoute,
  ): void {
    const cacheKey = buildReviewerCacheKey(route.owner, route.repo, pullNumber);
    rowFingerprints.set(cacheKey, createRowFingerprint(row, pullNumber));
  }

  function processRows(root: ParentNode = document): void {
    if (input.getRoute() == null) return;
    root.querySelectorAll(githubSelectors.row).forEach((row) => {
      void input.processRow(row);
    });
  }

  function processMutatedRow(target: Node): void {
    const route = input.getRoute();
    if (route == null) return;
    const element = target instanceof Element ? target : target.parentElement;
    if (element == null || element.closest("[data-ghpsr-root]") != null) {
      return;
    }
    const row = element.closest(githubSelectors.row);
    if (row == null) return;
    const pullNumber = extractPullNumber(row);
    if (pullNumber == null) return;
    const cacheKey = buildReviewerCacheKey(route.owner, route.repo, pullNumber);
    const nextFingerprint = createRowFingerprint(row, pullNumber);
    const previousFingerprint = rowFingerprints.get(cacheKey);
    rowFingerprints.set(cacheKey, nextFingerprint);
    if (previousFingerprint === nextFingerprint) {
      return;
    }
    markReviewerCacheStale(cacheKey);
    input.markPageMetadataStale();
    void input.processRow(row);
  }

  function observe(): MutationObserver {
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
            void input.processRow(node);
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
