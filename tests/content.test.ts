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

type Aggregator = {
  reportUncoveredOwner: ReturnType<typeof vi.fn>;
  reportUnauthRateLimit: ReturnType<typeof vi.fn>;
  teardown?: ReturnType<typeof vi.fn>;
};

type RowFailure = {
  owner: string;
  repo: string;
  account: { id: string } | null;
  error: unknown;
};

type BootReviewerOptions = {
  onRowFailure?: (signal: RowFailure) => void;
};

async function bootContent(aggregator: Aggregator): Promise<{
  onRowFailure: (signal: RowFailure) => void;
}> {
  bootAccessBannerMock.mockReturnValue(aggregator);
  window.history.replaceState(
    {},
    "",
    "/hon454/github-pulls-show-reviewers/pulls",
  );

  let captured: BootReviewerOptions | undefined;
  bootReviewerListPageMock.mockImplementation(
    (_ctx: never, options?: BootReviewerOptions) => {
      captured = options;
    },
  );

  const ctx = { addEventListener: vi.fn() };
  const { default: content } = await import("../entrypoints/content");
  content.main(ctx as never);

  if (captured?.onRowFailure == null) {
    throw new Error("bootReviewerListPage was not called with onRowFailure");
  }
  return { onRowFailure: captured.onRowFailure };
}

describe("content entrypoint", () => {
  it("keeps a broad content-script match so same-document PR-list navigation stays supported", async () => {
    const { default: content } = await import("../entrypoints/content");
    expect(content.matches).toEqual(["https://github.com/*/*"]);
  });

  it("waits to boot PR-list features until navigation enters a PR list", async () => {
    const aggregator = {
      reportUncoveredOwner: vi.fn(),
      reportUnauthRateLimit: vi.fn(),
      teardown: vi.fn(),
    };
    bootAccessBannerMock.mockReturnValue(aggregator);

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

    expect(bootAccessBannerMock).not.toHaveBeenCalled();
    expect(bootReviewerListPageMock).not.toHaveBeenCalled();

    window.history.replaceState(
      {},
      "",
      "/hon454/github-pulls-show-reviewers/pulls",
    );
    listeners.get("wxt:locationchange")?.forEach((listener) => listener());

    expect(bootAccessBannerMock).toHaveBeenCalledTimes(1);
    expect(bootReviewerListPageMock).toHaveBeenCalledTimes(1);
  });

  describe("onRowFailure banner classification", () => {
    function makeAggregator(): Aggregator {
      return {
        reportUncoveredOwner: vi.fn(),
        reportUnauthRateLimit: vi.fn(),
        teardown: vi.fn(),
      };
    }

    it("treats a 429 in any failure of a pull-request endpoints error as rate-limited", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      const error = new GitHubPullRequestEndpointsError([
        new GitHubApiError(404),
        new GitHubApiError(429),
      ]);
      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error,
      });

      expect(aggregator.reportUnauthRateLimit).toHaveBeenCalledTimes(1);
      expect(aggregator.reportUncoveredOwner).not.toHaveBeenCalled();
    });

    it("treats mixed 404 + 403 with an account as uncovered-owner (no rate limit)", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      const error = new GitHubPullRequestEndpointsError([
        new GitHubApiError(404),
        new GitHubApiError(403),
      ]);
      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error,
      });

      expect(aggregator.reportUncoveredOwner).toHaveBeenCalledWith("cinev");
      expect(aggregator.reportUnauthRateLimit).not.toHaveBeenCalled();
    });

    it("treats a 403 without an account as unauthenticated rate-limit", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      const error = new GitHubPullRequestEndpointsError([
        new GitHubApiError(403),
      ]);
      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: null,
        error,
      });

      expect(aggregator.reportUnauthRateLimit).toHaveBeenCalledTimes(1);
      expect(aggregator.reportUncoveredOwner).not.toHaveBeenCalled();
    });

    it("falls through to uncovered-owner for non-GitHubApiError errors", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);

      // e.g., a schema error or a generic network error: we can't classify
      // but we still want the banner to give the user actionable guidance.
      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new Error("Network down"),
      });

      expect(aggregator.reportUncoveredOwner).toHaveBeenCalledWith("cinev");
      expect(aggregator.reportUnauthRateLimit).not.toHaveBeenCalled();
    });
  });
});
