// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bootAccessBannerMock = vi.fn();
const bootReviewerListPageMock = vi.fn();

vi.mock("../src/features/access-banner", () => ({
  bootAccessBanner: bootAccessBannerMock,
}));

vi.mock("../src/features/reviewers", () => ({
  bootReviewerListPage: bootReviewerListPageMock,
}));

type Listener = () => void;

beforeEach(() => {
  vi.resetModules();
  bootAccessBannerMock.mockReset();
  bootReviewerListPageMock.mockReset();
  vi.stubGlobal(
    "defineContentScript",
    <T>(config: T) => config,
  );
  window.history.replaceState(
    {},
    "",
    "/hon454/github-pulls-show-reviewers",
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content entrypoint", () => {
  it("narrows its content-script match pattern to PR list routes", async () => {
    const { default: content } = await import("../entrypoints/content");
    expect(content.matches).toEqual(["https://github.com/*/*/pulls*"]);
  });

  it("re-initializes the access banner when navigation enters a PR list", async () => {
    const aggregator = {
      reportUncoveredOwner: vi.fn(),
      reportUnauthRateLimit: vi.fn(),
    };
    bootAccessBannerMock
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(aggregator);

    const listeners = new Map<string, Listener[]>();
    const ctx = {
      addEventListener: vi.fn(
        (_target: EventTarget, event: string, listener: Listener) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        },
      ),
    };

    const { default: content } = await import("../entrypoints/content");
    content.main(ctx as never);

    expect(bootAccessBannerMock).toHaveBeenCalledTimes(1);

    window.history.replaceState(
      {},
      "",
      "/hon454/github-pulls-show-reviewers/pulls",
    );
    listeners.get("wxt:locationchange")?.forEach((listener) => listener());

    expect(bootAccessBannerMock).toHaveBeenCalledTimes(2);
  });
});
