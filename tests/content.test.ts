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
  reportFailure: ReturnType<typeof vi.fn>;
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
      reportFailure: vi.fn(),
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
        reportFailure: vi.fn(),
        teardown: vi.fn(),
      };
    }

    it("emits auth-expired for account + 401", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(401)]),
      });

      expect(aggregator.reportFailure).toHaveBeenCalledWith("auth-expired");
    });

    it("emits app-uncovered for account + 404 (no rate-limit signal)", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(404)]),
      });

      expect(aggregator.reportFailure).toHaveBeenCalledWith("app-uncovered");
    });

    it("emits app-uncovered for account + 403 without rate-limit signal", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new GitHubPullRequestEndpointsError([
          new GitHubApiError(403, "forbidden"),
        ]),
      });

      expect(aggregator.reportFailure).toHaveBeenCalledWith("app-uncovered");
    });

    it("emits auth-rate-limit for account + 403 with rate-limit headers", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new GitHubPullRequestEndpointsError([
          new GitHubApiError(403, undefined, undefined, {
            limit: 5000,
            remaining: 0,
            resource: "core",
            resetAt: 1,
          }),
        ]),
      });

      expect(aggregator.reportFailure).toHaveBeenCalledWith("auth-rate-limit");
    });

    it("emits auth-rate-limit for account + 429", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(429)]),
      });

      expect(aggregator.reportFailure).toHaveBeenCalledWith("auth-rate-limit");
    });

    it("emits unauth-rate-limit for no account + 403 with rate-limit headers", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: null,
        error: new GitHubPullRequestEndpointsError([
          new GitHubApiError(403, undefined, undefined, {
            limit: 60,
            remaining: 0,
            resource: "core",
            resetAt: 1,
          }),
        ]),
      });

      expect(aggregator.reportFailure).toHaveBeenCalledWith("unauth-rate-limit");
    });

    it("emits signin-required for no account + 403 without rate-limit signal", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: null,
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(403)]),
      });

      expect(aggregator.reportFailure).toHaveBeenCalledWith("signin-required");
    });

    it("emits signin-required for no account + 401", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: null,
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(401)]),
      });

      expect(aggregator.reportFailure).toHaveBeenCalledWith("signin-required");
    });

    it("emits unauth-rate-limit for no account + 429", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: null,
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(429)]),
      });

      expect(aggregator.reportFailure).toHaveBeenCalledWith("unauth-rate-limit");
    });

    it("emits signin-required for no account + 404", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: null,
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(404)]),
      });

      expect(aggregator.reportFailure).toHaveBeenCalledWith("signin-required");
    });

    it("picks the highest-priority kind across mixed failures (auth-expired wins over app-uncovered)", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } = await import(
        "../src/github/api"
      );

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new GitHubPullRequestEndpointsError([
          new GitHubApiError(404),
          new GitHubApiError(401),
        ]),
      });

      expect(aggregator.reportFailure).toHaveBeenCalledTimes(1);
      expect(aggregator.reportFailure).toHaveBeenCalledWith("auth-expired");
    });

    it("does not emit any kind for unattributed errors (network, schema, unknown envelope, empty failures)", async () => {
      const cases: unknown[] = [
        new Error("Network down"),
        { kind: "schema", status: null, message: "Response shape changed" },
        { kind: "unknown", status: null, message: "Background fetch aborted" },
        { kind: "github-endpoints", status: null, failures: [] },
      ];

      for (const error of cases) {
        const aggregator = makeAggregator();
        const { onRowFailure } = await bootContent(aggregator);
        onRowFailure({
          owner: "cinev",
          repo: "shotloom",
          account: { id: "acc-1" },
          error,
        });
        expect(aggregator.reportFailure).not.toHaveBeenCalled();
      }
    });

    it("classifies serialized envelope failures with rateLimited identical to live errors", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: {
          kind: "github-endpoints",
          status: 403,
          failures: [
            {
              status: 403,
              endpoint: "/repos/cinev/shotloom/pulls/42",
              rateLimited: true,
            },
          ],
        },
      });

      expect(aggregator.reportFailure).toHaveBeenCalledWith("auth-rate-limit");
    });
  });
});
