// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBannerAggregator,
  formatBannerMessage,
} from "../src/features/access-banner/aggregator";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
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
