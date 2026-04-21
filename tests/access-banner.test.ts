// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBannerAggregator,
  formatBannerMessage,
} from "../src/features/access-banner/aggregator";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("bannerAggregator", () => {
  it("starts empty", () => {
    const aggregator = createBannerAggregator({ pathname: "/cinev/shotloom/pulls" });
    expect(aggregator.getState()).toEqual({
      uncoveredOrgs: [],
      unauthRateLimited: false,
      dismissed: false,
    });
  });

  it("dedupes org entries case-insensitively", () => {
    const aggregator = createBannerAggregator({ pathname: "/x/pulls" });
    aggregator.reportUncoveredOwner("CINEV");
    aggregator.reportUncoveredOwner("cinev");
    aggregator.reportUncoveredOwner("cinev");
    expect(aggregator.getState().uncoveredOrgs).toEqual(["cinev"]);
  });

  it("flags an unauth rate limit", () => {
    const aggregator = createBannerAggregator({ pathname: "/x/pulls" });
    aggregator.reportUnauthRateLimit();
    expect(aggregator.getState().unauthRateLimited).toBe(true);
  });

  it("persists dismissal by pathname via sessionStorage", () => {
    const first = createBannerAggregator({ pathname: "/cinev/shotloom/pulls" });
    first.dismiss();
    const second = createBannerAggregator({ pathname: "/cinev/shotloom/pulls" });
    expect(second.getState().dismissed).toBe(true);
    const other = createBannerAggregator({ pathname: "/other/repo/pulls" });
    expect(other.getState().dismissed).toBe(false);
  });

  it("resets dismissal when the pathname changes", () => {
    const first = createBannerAggregator({ pathname: "/cinev/shotloom/pulls" });
    first.dismiss();
    const second = createBannerAggregator({ pathname: "/cinev/landing/pulls" });
    expect(second.getState().dismissed).toBe(false);
  });
});

describe("formatBannerMessage", () => {
  it("formats a single uncovered org", () => {
    const text = formatBannerMessage({
      uncoveredOrgs: ["cinev"],
      unauthRateLimited: false,
    });
    expect(text).toBe(
      "Add GitHub App access to @cinev to see reviewers on this page.",
    );
  });

  it("formats multiple uncovered orgs", () => {
    const text = formatBannerMessage({
      uncoveredOrgs: ["cinev", "acme", "beta"],
      unauthRateLimited: false,
    });
    expect(text).toBe(
      "Add GitHub App access to @cinev and 2 more organizations.",
    );
  });

  it("formats an unauth rate limit message when nothing else is reported", () => {
    const text = formatBannerMessage({
      uncoveredOrgs: [],
      unauthRateLimited: true,
    });
    expect(text).toBe(
      "You hit GitHub's unauthenticated rate limit.",
    );
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
    banner.update({ uncoveredOrgs: [], unauthRateLimited: false, dismissed: false });
    expect(document.querySelector("[data-ghpsr-banner]")).toBeNull();
  });

  it("inserts the banner when an uncovered org is reported", () => {
    document.body.innerHTML = `<main><div class="gh-header"></div></main>`;
    const target = document.querySelector<HTMLElement>(".gh-header")!;
    const banner = mountBanner({
      insertAfter: target,
      installUrl: "https://github.com/apps/test-app/installations/new",
      optionsPageUrl: "chrome-extension://ext-id/options.html",
      onDismiss: () => {},
    });
    banner.update({
      uncoveredOrgs: ["cinev"],
      unauthRateLimited: false,
      dismissed: false,
    });
    const el = document.querySelector("[data-ghpsr-banner]");
    expect(el?.textContent).toContain("@cinev");
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
      uncoveredOrgs: ["cinev"],
      unauthRateLimited: false,
      dismissed: false,
    });
    banner.update({
      uncoveredOrgs: ["cinev"],
      unauthRateLimited: false,
      dismissed: true,
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
