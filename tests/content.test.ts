import type * as UIClientModule from "../src/runtime/ui-client";
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

import type { ReviewerOutcomeSnapshot } from "../src/features/reviewers/outcomes";

type Listener = () => void;

beforeEach(() => {
  vi.resetModules();
  bootAccessBannerMock.mockReset();
  bootReviewerListPageMock.mockReset();
  vi.stubGlobal("defineContentScript", <T>(config: T) => config);
  vi.stubGlobal("browser", {
    runtime: {
      id: "content-test",
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  window.history.replaceState({}, "", "/hon454/github-pulls-show-reviewers");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Aggregator = {
  refreshMount?: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
  teardown?: ReturnType<typeof vi.fn>;
};

type RowFailure = {
  owner: string;
  repo: string;
  account: { id: string } | null;
  error: unknown;
};

type BootReviewerOptions = {
  onOutcomes?: (snapshot: ReviewerOutcomeSnapshot) => void;
};

async function bootContent(aggregator: Aggregator): Promise<{
  onRowFailure: (signal: RowFailure) => void;
}> {
  aggregator.refreshMount = vi.fn();
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

  const ctx = { addEventListener: vi.fn(), onInvalidated: vi.fn() };
  const { default: content } = await import("../entrypoints/content");
  content.main(ctx as never);

  if (captured?.onOutcomes == null) {
    throw new Error("bootReviewerListPage was not called with onOutcomes");
  }
  const onOutcomes = captured.onOutcomes;
  return {
    onRowFailure: (failure) =>
      onOutcomes({
        generation: 0,
        pathname: window.location.pathname,
        rows: [
          {
            pullNumber: "42",
            request: {},
            outcome: { status: "failure", failure },
          },
        ],
      }),
  };
}

function expectFailure(
  aggregator: Aggregator,
  kind: string,
  info?: unknown,
): void {
  expect(aggregator.reconcile).toHaveBeenCalledWith({
    generation: 0,
    pending: false,
    failures: [info == null ? { kind } : { kind, info }],
  });
}

describe("content entrypoint", () => {
  it("keeps a broad content-script match so same-document PR-list navigation stays supported", async () => {
    const { default: content } = await import("../entrypoints/content");
    expect(content.matches).toEqual(["https://github.com/*/*"]);
  });

  it("waits to boot PR-list features until navigation enters a PR list", async () => {
    const aggregator = {
      refreshMount: vi.fn(),
      reconcile: vi.fn(),
      teardown: vi.fn(),
    };
    bootAccessBannerMock.mockReturnValue(aggregator);

    const listeners = new Map<string, Listener[]>();
    const ctx = {
      onInvalidated: vi.fn(),
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
        reconcile: vi.fn(),
        teardown: vi.fn(),
      };
    }

    it("emits auth-expired for account + 401", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } =
        await import("../src/github/api");

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(401)]),
      });

      expectFailure(aggregator, "auth-expired");
    });

    it("emits app-uncovered for account + 404 (no rate-limit signal)", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } =
        await import("../src/github/api");

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(404)]),
      });

      expectFailure(aggregator, "app-uncovered");
    });

    it("emits app-uncovered for account + 403 without rate-limit signal", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } =
        await import("../src/github/api");

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new GitHubPullRequestEndpointsError([
          new GitHubApiError(403, "forbidden"),
        ]),
      });

      expectFailure(aggregator, "app-uncovered");
    });

    it("emits auth-rate-limit with the response snapshot for account + 403 + rate-limit headers", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } =
        await import("../src/github/api");

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

      expectFailure(aggregator, "auth-rate-limit", {
        rateLimit: {
          limit: 5000,
          remaining: 0,
          resource: "core",
          resetAt: 1,
        },
      });
    });

    it("emits auth-rate-limit without a snapshot for account + 429 with no headers", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } =
        await import("../src/github/api");

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(429)]),
      });

      expectFailure(aggregator, "auth-rate-limit");
    });

    it("backfills rate-limit details from a later same-kind failure", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } =
        await import("../src/github/api");

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new GitHubPullRequestEndpointsError([
          new GitHubApiError(429),
          new GitHubApiError(403, undefined, undefined, {
            limit: 5000,
            remaining: 0,
            resource: "core",
            resetAt: 1,
          }),
        ]),
      });

      expectFailure(aggregator, "auth-rate-limit", {
        rateLimit: {
          limit: 5000,
          remaining: 0,
          resource: "core",
          resetAt: 1,
        },
      });
    });

    it("emits unauth-rate-limit with the response snapshot for no account + 403 + rate-limit headers", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } =
        await import("../src/github/api");

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

      expectFailure(aggregator, "unauth-rate-limit", {
        rateLimit: {
          limit: 60,
          remaining: 0,
          resource: "core",
          resetAt: 1,
        },
      });
    });

    it("emits signin-required for no account + 403 without rate-limit signal", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } =
        await import("../src/github/api");

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: null,
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(403)]),
      });

      expectFailure(aggregator, "signin-required");
    });

    it("emits signin-required for no account + 401", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } =
        await import("../src/github/api");

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: null,
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(401)]),
      });

      expectFailure(aggregator, "signin-required");
    });

    it("emits unauth-rate-limit without a snapshot for no account + 429 with no headers", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } =
        await import("../src/github/api");

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: null,
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(429)]),
      });

      expectFailure(aggregator, "unauth-rate-limit");
    });

    it("emits signin-required for no account + 404", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } =
        await import("../src/github/api");

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: null,
        error: new GitHubPullRequestEndpointsError([new GitHubApiError(404)]),
      });

      expectFailure(aggregator, "signin-required");
    });

    it("picks the highest-priority kind across mixed failures (auth-expired wins over app-uncovered)", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError, GitHubPullRequestEndpointsError } =
        await import("../src/github/api");

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: { id: "acc-1" },
        error: new GitHubPullRequestEndpointsError([
          new GitHubApiError(404),
          new GitHubApiError(401),
        ]),
      });

      expect(aggregator.reconcile).toHaveBeenCalledTimes(1);
      const winningKind =
        aggregator.reconcile.mock.calls[0][0].failures[0].kind;
      expect(winningKind).toBe("auth-expired");
    });

    it("emits reviewers-unavailable for network, schema, unknown, and empty-envelope failures", async () => {
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
        expectFailure(aggregator, "reviewers-unavailable");
      }
    });

    it("emits reviewers-unavailable for an unclassified GitHub status", async () => {
      const aggregator = makeAggregator();
      const { onRowFailure } = await bootContent(aggregator);
      const { GitHubApiError } = await import("../src/github/api");

      onRowFailure({
        owner: "cinev",
        repo: "shotloom",
        account: null,
        error: new GitHubApiError(500),
      });

      expectFailure(aggregator, "reviewers-unavailable");
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
              rateLimit: {
                limit: 5000,
                remaining: 0,
                resource: "core",
                resetAt: 1_700_000_000,
              },
            },
          ],
        },
      });

      expectFailure(aggregator, "auth-rate-limit", {
        rateLimit: {
          limit: 5000,
          remaining: 0,
          resource: "core",
          resetAt: 1_700_000_000,
        },
      });
    });
  });
});

it("shares one locale subscription across content features and releases it on route/context teardown", async () => {
  vi.doUnmock("../src/features/access-banner");
  vi.doUnmock("../src/features/reviewers");
  vi.resetModules();
  const { createUIPresentationFixtures } =
    await import("./helpers/ui-presentation-fixtures");
  const { DEFAULT_PREFERENCES } = await import("../src/shared/preferences");
  const uiFixtures = createUIPresentationFixtures(
    async () => DEFAULT_PREFERENCES,
  );
  const storageListeners = uiFixtures.listeners;
  vi.doMock("../src/runtime/ui-client", async (importActual) => ({
    ...(await importActual<typeof UIClientModule>()),
    getUIClient: () => uiFixtures.client,
    disposeUIClient: () => uiFixtures.client.dispose(),
  }));
  const routeListeners = new Map<string, Array<() => void>>();
  const invalidations: Array<() => void> = [];
  vi.stubGlobal("__GITHUB_APP_CLIENT_ID__", "Iv1.testclient");
  vi.stubGlobal("__GITHUB_APP_SLUG__", "test-app");
  vi.stubGlobal("__GITHUB_APP_NAME__", "Test App");
  vi.stubGlobal("__PROD__", true);
  vi.stubGlobal("browser", {
    i18n: { getUILanguage: () => "en" },
    runtime: {
      getURL: (path: string) => `chrome-extension://test${path}`,
      sendMessage: vi.fn(),
    },
    storage: {
      onChanged: {
        addListener: vi.fn(() => {
          throw new Error("UI storage listener");
        }),
      },
    },
  });
  document.body.innerHTML = "<main></main>";
  window.history.replaceState({}, "", "/org/repo/pulls");
  const ctx = {
    addEventListener: (_target: EventTarget, name: string, fn: () => void) =>
      routeListeners.set(name, [...(routeListeners.get(name) ?? []), fn]),
    setInterval: vi.fn(),
    onInvalidated: (fn: () => void) => invalidations.push(fn),
  };
  try {
    const { default: content } = await import("../entrypoints/content");
    content.main(ctx as never);
    // One shared locale subscription plus the reviewer snapshot subscription.
    expect(storageListeners.size).toBe(2);
    window.history.replaceState({}, "", "/org/repo/issues");
    routeListeners.get("wxt:locationchange")!.forEach((fn) => fn());
    expect(storageListeners.size).toBe(1);
    window.history.replaceState({}, "", "/org/repo/pulls");
    routeListeners.get("wxt:locationchange")!.forEach((fn) => fn());
    expect(storageListeners.size).toBe(2);
    invalidations.forEach((fn) => fn());
    expect(storageListeners.size).toBe(0);
  } finally {
    invalidations.forEach((fn) => fn());
    vi.doUnmock("../src/runtime/ui-client");
    vi.doMock("../src/features/access-banner", () => ({
      bootAccessBanner: bootAccessBannerMock,
    }));
    vi.doMock("../src/features/reviewers", () => ({
      bootReviewerListPage: bootReviewerListPageMock,
    }));
  }
});
