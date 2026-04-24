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
  reportUncovered: ReturnType<typeof vi.fn>;
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
      reportUncovered: vi.fn(),
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
        reportUncovered: vi.fn(),
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
      expect(aggregator.reportUncovered).not.toHaveBeenCalled();
    });

    it("treats mixed 404 + 403 with an account as uncovered (no rate limit)", async () => {
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

      expect(aggregator.reportUncovered).toHaveBeenCalledTimes(1);
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
      expect(aggregator.reportUncovered).not.toHaveBeenCalled();
    });

    it("does not show any banner for unattributed errors (schema drift, network, etc.)", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);

      // A generic network error: we cannot attribute this to App coverage.
      // The Configure access banner would be misleading guidance, so we stay
      // silent and let the developer diagnose via console warnings.
      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new Error("Network down"),
      });

      expect(aggregator.reportUncovered).not.toHaveBeenCalled();
      expect(aggregator.reportUnauthRateLimit).not.toHaveBeenCalled();
    });

    it("does not show any banner for schema envelope failures", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: {
          kind: "schema",
          status: null,
          message: "Response shape changed",
        },
      });

      expect(aggregator.reportUncovered).not.toHaveBeenCalled();
      expect(aggregator.reportUnauthRateLimit).not.toHaveBeenCalled();
    });

    it("does not show any banner for unknown envelope failures", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: {
          kind: "unknown",
          status: null,
          message: "Background fetch aborted",
        },
      });

      expect(aggregator.reportUncovered).not.toHaveBeenCalled();
      expect(aggregator.reportUnauthRateLimit).not.toHaveBeenCalled();
    });

    it("does not show any banner for empty endpoint envelope failures", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: {
          kind: "github-endpoints",
          status: null,
          failures: [],
        },
      });

      expect(aggregator.reportUncovered).not.toHaveBeenCalled();
      expect(aggregator.reportUnauthRateLimit).not.toHaveBeenCalled();
    });

    it("classifies serialized reviewer-fetch failures the same way as GitHubApiError instances", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: {
          kind: "github-endpoints",
          status: 404,
          failures: [
            { status: 404, endpoint: "/repos/cinev/shotloom/pulls/42" },
            { status: 403, endpoint: "/repos/cinev/shotloom/pulls/42/reviews" },
          ],
        },
      });

      expect(aggregator.reportUncovered).toHaveBeenCalledTimes(1);
      expect(aggregator.reportUnauthRateLimit).not.toHaveBeenCalled();
    });
  });
});
