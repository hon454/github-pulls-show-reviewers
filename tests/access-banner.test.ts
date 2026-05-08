// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBannerAggregator,
  formatBannerMessage,
} from "../src/features/access-banner/aggregator";

const TEST_REPO = { owner: "cinev", name: "shotloom" } as const;

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("bannerAggregator", () => {
  it("starts with current=null and carries the repo", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    expect(aggregator.getState()).toEqual({
      current: null,
      dismissed: false,
      repo: TEST_REPO,
    });
  });

  it("flips current to the reported kind and is idempotent for the same kind", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    const listener = vi.fn();
    aggregator.subscribe(listener);
    listener.mockClear();

    aggregator.reportFailure("signin-required");
    aggregator.reportFailure("signin-required");
    aggregator.reportFailure("signin-required");

    expect(aggregator.getState().current).toBe("signin-required");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("upgrades current when a higher-priority kind is reported", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    aggregator.reportFailure("signin-required");
    aggregator.reportFailure("auth-expired");
    expect(aggregator.getState().current).toBe("auth-expired");
  });

  it("ignores a lower-priority kind once a higher-priority kind is set", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    aggregator.reportFailure("auth-expired");
    aggregator.reportFailure("signin-required");
    expect(aggregator.getState().current).toBe("auth-expired");
  });

  it("orders priority: auth-expired > app-uncovered > auth-rate-limit > unauth-rate-limit > signin-required", () => {
    const order = [
      "signin-required",
      "unauth-rate-limit",
      "auth-rate-limit",
      "app-uncovered",
      "auth-expired",
    ] as const;
    for (let i = 0; i < order.length - 1; i++) {
      const aggregator = createBannerAggregator({
        pathname: `/cinev/shotloom/pulls?case=${i}`,
        repo: TEST_REPO,
      });
      aggregator.reportFailure(order[i]);
      aggregator.reportFailure(order[i + 1]);
      expect(aggregator.getState().current).toBe(order[i + 1]);
    }
  });

  it("ignores dismiss when current is null", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    aggregator.dismiss();
    expect(aggregator.getState().dismissed).toBe(false);
  });

  it("persists dismissal scoped to pathname + kind", () => {
    const first = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    first.reportFailure("signin-required");
    first.dismiss();
    expect(first.getState().dismissed).toBe(true);

    const second = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    second.reportFailure("signin-required");
    expect(second.getState().dismissed).toBe(true);
  });

  it("does not carry a kind A dismissal over to kind B on the same pathname", () => {
    const a = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    a.reportFailure("signin-required");
    a.dismiss();

    const b = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    b.reportFailure("auth-expired");
    expect(b.getState().dismissed).toBe(false);
  });

  it("carries the rate-limit snapshot when reportFailure is called with one", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    const snapshot = {
      limit: 5000,
      remaining: 0,
      resource: "core",
      resetAt: 1_700_000_300,
    };
    aggregator.reportFailure("auth-rate-limit", { rateLimit: snapshot });
    expect(aggregator.getState()).toMatchObject({
      current: "auth-rate-limit",
      rateLimit: snapshot,
    });
  });

  it("ignores info passed for non-rate-limit kinds", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    aggregator.reportFailure("auth-expired", {
      rateLimit: { limit: 1, remaining: 0, resource: null, resetAt: null },
    });
    expect(aggregator.getState().rateLimit).toBeUndefined();
  });

  it("backfills the rate-limit snapshot when a later same-kind report carries one", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    aggregator.reportFailure("auth-rate-limit");
    expect(aggregator.getState().rateLimit).toBeUndefined();
    const snapshot = {
      limit: 5000,
      remaining: 0,
      resource: "core",
      resetAt: 1_700_000_300,
    };
    aggregator.reportFailure("auth-rate-limit", { rateLimit: snapshot });
    expect(aggregator.getState().rateLimit).toEqual(snapshot);
  });

  it("keeps the first rate-limit snapshot when a later same-kind report has a different one", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    const first = {
      limit: 5000,
      remaining: 0,
      resource: "core",
      resetAt: 1_700_000_300,
    };
    const second = {
      limit: 5000,
      remaining: 1,
      resource: "core",
      resetAt: 1_700_001_000,
    };
    aggregator.reportFailure("auth-rate-limit", { rateLimit: first });
    aggregator.reportFailure("auth-rate-limit", { rateLimit: second });
    expect(aggregator.getState().rateLimit).toEqual(first);
  });

  it("clears the rate-limit snapshot when a higher-priority non-rate-limit kind takes over", () => {
    const aggregator = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    aggregator.reportFailure("auth-rate-limit", {
      rateLimit: {
        limit: 5000,
        remaining: 0,
        resource: "core",
        resetAt: 1_700_000_300,
      },
    });
    aggregator.reportFailure("auth-expired");
    expect(aggregator.getState().rateLimit).toBeUndefined();
  });

  it("re-reads dismissed from storage when current is upgraded to a kind dismissed earlier", () => {
    const seed = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    seed.reportFailure("auth-expired");
    seed.dismiss();

    const fresh = createBannerAggregator({
      pathname: "/cinev/shotloom/pulls",
      repo: TEST_REPO,
    });
    fresh.reportFailure("signin-required");
    expect(fresh.getState().dismissed).toBe(false);
    fresh.reportFailure("auth-expired");
    expect(fresh.getState().current).toBe("auth-expired");
    expect(fresh.getState().dismissed).toBe(true);
  });
});

describe("formatBannerMessage", () => {
  it("returns auth-expired copy", () => {
    expect(
      formatBannerMessage({ current: "auth-expired", repo: TEST_REPO }),
    ).toBe(
      "Your GitHub session expired. Sign in again to keep loading reviewers.",
    );
  });

  it("names the repo and org for app-uncovered", () => {
    expect(
      formatBannerMessage({ current: "app-uncovered", repo: TEST_REPO }),
    ).toBe(
      "Add cinev/shotloom to @cinev's GitHub App installation to see reviewers on this page.",
    );
  });

  it("returns auth-rate-limit copy", () => {
    expect(
      formatBannerMessage({ current: "auth-rate-limit", repo: TEST_REPO }),
    ).toBe(
      "GitHub's hourly request limit was reached. Reviewers will resume automatically when the limit resets.",
    );
  });

  it("returns unauth-rate-limit copy that mentions the higher signed-in limit", () => {
    expect(
      formatBannerMessage({ current: "unauth-rate-limit", repo: TEST_REPO }),
    ).toBe(
      "GitHub's unauthenticated request limit was reached. (60/hr unauthenticated cap) Sign in to raise it to 5,000/hr.",
    );
  });

  it("includes used/limit details for auth-rate-limit when a snapshot is present", () => {
    expect(
      formatBannerMessage(
        {
          current: "auth-rate-limit",
          repo: TEST_REPO,
          rateLimit: {
            limit: 5000,
            remaining: 0,
            resource: "core",
            resetAt: 1_700_000_300,
          },
        },
        { now: () => 1_700_000_000 * 1000 }, // ~5 minutes before reset
      ),
    ).toBe(
      "GitHub's hourly request limit was reached. (5000/5000 used) Reviewers will resume in about 5 minutes.",
    );
  });

  it("includes used/limit details and reset time for unauth-rate-limit when a snapshot is present", () => {
    expect(
      formatBannerMessage(
        {
          current: "unauth-rate-limit",
          repo: TEST_REPO,
          rateLimit: {
            limit: 60,
            remaining: 0,
            resource: "core",
            resetAt: 1_700_000_300,
          },
        },
        { now: () => 1_700_000_000 * 1000 },
      ),
    ).toBe(
      "GitHub's unauthenticated request limit was reached. (60/60 used) Sign in to raise it to 5,000/hr. Resets in about 5 minutes.",
    );
  });

  it("falls back to the limit-only segment when only the reset time is missing", () => {
    expect(
      formatBannerMessage({
        current: "auth-rate-limit",
        repo: TEST_REPO,
        rateLimit: {
          limit: 5000,
          remaining: 0,
          resource: "core",
          resetAt: null,
        },
      }),
    ).toBe(
      "GitHub's hourly request limit was reached. (5000/5000 used) Reviewers will resume automatically when the limit resets.",
    );
  });

  it("falls back to the reset-time segment when limit/remaining are missing", () => {
    expect(
      formatBannerMessage(
        {
          current: "auth-rate-limit",
          repo: TEST_REPO,
          rateLimit: {
            limit: null,
            remaining: null,
            resource: null,
            resetAt: 1_700_003_600,
          },
        },
        { now: () => 1_700_000_000 * 1000 }, // ~1 hour before reset
      ),
    ).toBe(
      "GitHub's hourly request limit was reached. Reviewers will resume in about 1 hour.",
    );
  });

  it("uses 'shortly' when the reset time is already in the past", () => {
    expect(
      formatBannerMessage(
        {
          current: "auth-rate-limit",
          repo: TEST_REPO,
          rateLimit: {
            limit: null,
            remaining: null,
            resource: null,
            resetAt: 1_699_999_000,
          },
        },
        { now: () => 1_700_000_000 * 1000 },
      ),
    ).toBe(
      "GitHub's hourly request limit was reached. Reviewers will resume shortly.",
    );
  });

  it("returns signin-required copy that mentions private repos", () => {
    expect(
      formatBannerMessage({ current: "signin-required", repo: TEST_REPO }),
    ).toBe(
      "Sign in with GitHub to see reviewers on private repositories.",
    );
  });

  it("returns an empty string when current is null", () => {
    expect(
      formatBannerMessage({ current: null, repo: TEST_REPO }),
    ).toBe("");
  });
});

import { mountBanner } from "../src/features/access-banner/dom";

describe("banner DOM", () => {
  function setup() {
    document.body.innerHTML = `<main><div class="gh-header"></div></main>`;
    const target = document.querySelector<HTMLElement>(".gh-header")!;
    return mountBanner({
      insertAfter: target,
      installUrl: "https://github.com/apps/test-app/installations/new",
      optionsPageUrl: "chrome-extension://ext-id/options.html",
      onDismiss: () => {},
    });
  }

  it("does not insert a banner when current is null", () => {
    const banner = setup();
    banner.update({ current: null, dismissed: false, repo: TEST_REPO });
    expect(document.querySelector("[data-ghpsr-banner]")).toBeNull();
  });

  it("renders Configure access link for app-uncovered", () => {
    const banner = setup();
    banner.update({ current: "app-uncovered", dismissed: false, repo: TEST_REPO });
    const el = document.querySelector("[data-ghpsr-banner]")!;
    expect(el.textContent).toContain("cinev/shotloom");
    expect(el.textContent).toContain("@cinev's GitHub App installation");
    const link = el.querySelector("a");
    expect(link?.textContent).toBe("Configure access");
    expect(link?.getAttribute("href")).toBe(
      "https://github.com/apps/test-app/installations/new",
    );
  });

  it("renders Sign in link for unauth-rate-limit", () => {
    const banner = setup();
    banner.update({
      current: "unauth-rate-limit",
      dismissed: false,
      repo: TEST_REPO,
    });
    const link = document.querySelector("[data-ghpsr-banner] a");
    expect(link?.textContent).toBe("Sign in");
    expect(link?.getAttribute("href")).toBe(
      "chrome-extension://ext-id/options.html",
    );
  });

  it("renders Sign in link for signin-required", () => {
    const banner = setup();
    banner.update({
      current: "signin-required",
      dismissed: false,
      repo: TEST_REPO,
    });
    const link = document.querySelector("[data-ghpsr-banner] a");
    expect(link?.textContent).toBe("Sign in");
    expect(link?.getAttribute("href")).toBe(
      "chrome-extension://ext-id/options.html",
    );
  });

  it("renders Sign in link for auth-expired", () => {
    const banner = setup();
    banner.update({
      current: "auth-expired",
      dismissed: false,
      repo: TEST_REPO,
    });
    const link = document.querySelector("[data-ghpsr-banner] a");
    expect(link?.textContent).toBe("Sign in");
    expect(link?.getAttribute("href")).toBe(
      "chrome-extension://ext-id/options.html",
    );
  });

  it("renders no CTA link for auth-rate-limit (passive wait)", () => {
    const banner = setup();
    banner.update({
      current: "auth-rate-limit",
      dismissed: false,
      repo: TEST_REPO,
    });
    const el = document.querySelector("[data-ghpsr-banner]")!;
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("button")?.textContent).toBe("Dismiss");
  });

  it("attaches focus-visible classes on the CTA link and dismiss button", () => {
    const banner = setup();
    banner.update({
      current: "app-uncovered",
      dismissed: false,
      repo: TEST_REPO,
    });
    const link = document.querySelector("[data-ghpsr-banner] a");
    const dismiss = document.querySelector("[data-ghpsr-banner] button");
    expect(link?.classList.contains("ghpsr-banner-cta")).toBe(true);
    expect(dismiss?.classList.contains("ghpsr-banner-dismiss")).toBe(true);
    const styleEl = document.querySelector("[data-ghpsr-banner-style]");
    expect(styleEl?.textContent).toContain(":focus-visible");
  });

  it("removes the banner when dismissed", () => {
    const banner = setup();
    banner.update({
      current: "app-uncovered",
      dismissed: false,
      repo: TEST_REPO,
    });
    banner.update({
      current: "app-uncovered",
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
