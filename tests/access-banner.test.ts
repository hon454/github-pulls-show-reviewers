// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBannerAggregator,
  formatBannerMessage,
} from "../src/features/access-banner/aggregator";

const TEST_REPO = { owner: "cinev", name: "shotloom" };

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("bannerAggregator", () => {
  it("starts with uncovered=false and carries the repo", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    expect(aggregator.getState()).toEqual({
      uncovered: false,
      unauthRateLimited: false,
      dismissed: false,
      repo: TEST_REPO,
    });
  });

  it("flips uncovered to true once reported and is idempotent", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    const listener = vi.fn();
    aggregator.subscribe(listener);
    listener.mockClear();

    aggregator.reportUncovered();
    aggregator.reportUncovered();
    aggregator.reportUncovered();

    expect(aggregator.getState().uncovered).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("flags an unauth rate limit", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    aggregator.reportUnauthRateLimit();
    expect(aggregator.getState().unauthRateLimited).toBe(true);
  });

  it("persists dismissal by pathname via sessionStorage", () => {
    const first = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    first.dismiss();
    const second = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    expect(second.getState().dismissed).toBe(true);
    const other = createBannerAggregator({
      pathname: "/other/repo/pulls",
      repo: { owner: "other", name: "repo" },
    });
    expect(other.getState().dismissed).toBe(false);
  });

  it("resets dismissal when the pathname changes", () => {
    const first = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    first.dismiss();
    const second = createBannerAggregator({
      pathname: "/cinev/landing/pulls",
      repo: { owner: "cinev", name: "landing" },
    });
    expect(second.getState().dismissed).toBe(false);
  });
});

describe("formatBannerMessage", () => {
  it("names the repo and org when uncovered", () => {
    const text = formatBannerMessage({
      uncovered: true,
      unauthRateLimited: false,
      repo: TEST_REPO,
    });
    expect(text).toBe(
      "Add cinev/shotloom to @cinev's GitHub App installation to see reviewers on this page.",
    );
  });

  it("prefers the uncovered message over the rate-limit message", () => {
    const text = formatBannerMessage({
      uncovered: true,
      unauthRateLimited: true,
      repo: TEST_REPO,
    });
    expect(text).toBe(
      "Add cinev/shotloom to @cinev's GitHub App installation to see reviewers on this page.",
    );
  });

  it("formats an unauth rate limit message when nothing else is reported", () => {
    const text = formatBannerMessage({
      uncovered: false,
      unauthRateLimited: true,
      repo: TEST_REPO,
    });
    expect(text).toBe("You hit GitHub's unauthenticated rate limit.");
  });

  it("returns an empty string when there is nothing to surface", () => {
    const text = formatBannerMessage({
      uncovered: false,
      unauthRateLimited: false,
      repo: TEST_REPO,
    });
    expect(text).toBe("");
  });
});

import { mountBanner } from "../src/features/access-banner/dom";

describe("banner DOM", () => {
  it("does not insert a banner when state is empty", () => {
    document.body.innerHTML = `<main><div class="gh-header"></div></main>`;
    const target = document.querySelector<HTMLElement>(".gh-header")!;
    const banner = mountBanner({
      insertAfter: target,
      installUrl: "https://github.com/apps/test-app/installations/new",
      optionsPageUrl: "chrome-extension://ext-id/options.html",
      onDismiss: () => {},
    });
    banner.update({
      uncovered: false,
      unauthRateLimited: false,
      dismissed: false,
      repo: TEST_REPO,
    });
    expect(document.querySelector("[data-ghpsr-banner]")).toBeNull();
  });

  it("inserts a repo-aware banner with a Configure access link when uncovered", () => {
    document.body.innerHTML = `<main><div class="gh-header"></div></main>`;
    const target = document.querySelector<HTMLElement>(".gh-header")!;
    const banner = mountBanner({
      insertAfter: target,
      installUrl: "https://github.com/apps/test-app/installations/new",
      optionsPageUrl: "chrome-extension://ext-id/options.html",
      onDismiss: () => {},
    });
    banner.update({
      uncovered: true,
      unauthRateLimited: false,
      dismissed: false,
      repo: TEST_REPO,
    });

    const el = document.querySelector("[data-ghpsr-banner]");
    expect(el?.textContent).toContain("cinev/shotloom");
    expect(el?.textContent).toContain("@cinev's GitHub App installation");
    const link = el?.querySelector("a");
    expect(link?.textContent).toBe("Configure access");
    expect(link?.getAttribute("href")).toBe(
      "https://github.com/apps/test-app/installations/new",
    );
  });

  it("renders a Sign in link for the unauth rate-limit state", () => {
    document.body.innerHTML = `<main><div class="gh-header"></div></main>`;
    const target = document.querySelector<HTMLElement>(".gh-header")!;
    const banner = mountBanner({
      insertAfter: target,
      installUrl: "https://github.com/apps/test-app/installations/new",
      optionsPageUrl: "chrome-extension://ext-id/options.html",
      onDismiss: () => {},
    });
    banner.update({
      uncovered: false,
      unauthRateLimited: true,
      dismissed: false,
      repo: TEST_REPO,
    });

    const link = document.querySelector("[data-ghpsr-banner] a");
    expect(link?.textContent).toBe("Sign in");
    expect(link?.getAttribute("href")).toBe(
      "chrome-extension://ext-id/options.html",
    );
  });

  it("removes the banner when dismissed", () => {
    document.body.innerHTML = `<main><div class="gh-header"></div></main>`;
    const target = document.querySelector<HTMLElement>(".gh-header")!;
    const banner = mountBanner({
      insertAfter: target,
      installUrl: "https://github.com/apps/test-app/installations/new",
      optionsPageUrl: "chrome-extension://ext-id/options.html",
      onDismiss: () => {},
    });
    banner.update({
      uncovered: true,
      unauthRateLimited: false,
      dismissed: false,
      repo: TEST_REPO,
    });
    banner.update({
      uncovered: true,
      unauthRateLimited: false,
      dismissed: true,
      repo: TEST_REPO,
    });
    expect(document.querySelector("[data-ghpsr-banner]")).toBeNull();
  });
});

describe("bootAccessBanner", () => {
  it("returns null instead of throwing when production GitHub App config is missing", async () => {
    vi.stubGlobal("__GITHUB_APP_CLIENT_ID__", "");
    vi.stubGlobal("__GITHUB_APP_SLUG__", "");
    vi.stubGlobal("__GITHUB_APP_NAME__", "");
    vi.stubGlobal("__PROD__", true);
    vi.stubGlobal("browser", {
      runtime: {
        getURL: (path: string) => `chrome-extension://ext-id${path}`,
      },
    });
    window.history.replaceState({}, "", "/hon454/github-pulls-show-reviewers/pulls");

    const { bootAccessBanner } = await import("../src/features/access-banner");
    const handle = bootAccessBanner({
      onInvalidated: () => {},
    } as never);

    expect(handle).toBeNull();
  });
});
