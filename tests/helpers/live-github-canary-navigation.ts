import type { Locator, Page } from "@playwright/test";

import type { CanaryFailure, CanaryRepository } from "./live-github-canary";

export type NavigationFailureCode =
  | "required-pagination-link-unavailable"
  | "required-filter-link-unavailable"
  | "navigation-url-unchanged"
  | "navigation-pull-set-unchanged"
  | "back-restore-set-mismatch"
  | "navigation-stage-failed";

export class NavigationEvidenceError extends Error {
  readonly failure: CanaryFailure;

  constructor(code: Exclude<NavigationFailureCode, "navigation-stage-failed">) {
    super(code);
    this.failure = { owner: "environment", code, pullNumber: null };
  }
}

export async function findNativePullListLink(
  page: Page,
  repository: CanaryRepository,
  predicate: (url: URL) => boolean,
  failureCode:
    | "required-pagination-link-unavailable"
    | "required-filter-link-unavailable",
): Promise<{ url: string; locator: Locator }> {
  const links = page.locator("main a[href]");
  const count = await links.count();
  for (let index = 0; index < count; index += 1) {
    const locator = links.nth(index);
    const href = await locator.getAttribute("href");
    if (href == null) continue;
    const url = new URL(href, page.url());
    if (
      url.origin !== "https://github.com" ||
      url.pathname.toLowerCase() !==
        `/${repository.owner}/${repository.repo}/pulls`.toLowerCase() ||
      !predicate(url) ||
      !(await locator.isVisible()) ||
      (await locator.getAttribute("aria-disabled")) === "true"
    )
      continue;
    return { url: url.toString(), locator };
  }
  throw new NavigationEvidenceError(failureCode);
}
