// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentScriptContext } from "wxt/utils/content-script-context";

import type { PullReviewerSummary } from "../src/github/api";
import type * as PreferencesModule from "../src/storage/preferences";

const resolveAccountForRepoMock = vi.fn();
const listAccountsMock = vi.fn();
const getPreferencesMock = vi.fn();
const runtimeSendMessageMock = vi.fn();

vi.mock("../src/storage/accounts", () => ({
  resolveAccountForRepo: resolveAccountForRepoMock,
  listAccounts: listAccountsMock,
}));

vi.mock("../src/storage/preferences", async () => {
  const actual = await vi.importActual<typeof PreferencesModule>(
    "../src/storage/preferences",
  );
  return {
    ...actual,
    getPreferences: getPreferencesMock,
  };
});

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type StorageChange = { oldValue?: unknown; newValue?: unknown };
type StorageListener = (
  changes: Record<string, StorageChange>,
  areaName: string,
) => void;

let capturedStorageListener: StorageListener | null = null;
let pendingTeardowns: Array<() => void>;

type TestCtx = {
  addEventListener: ReturnType<typeof vi.fn>;
  setInterval: ReturnType<typeof vi.fn>;
  onInvalidated: ReturnType<typeof vi.fn>;
};

function makeCtx(): TestCtx & ContentScriptContext {
  const teardowns: Array<() => void> = [];
  pendingTeardowns.push(() => teardowns.forEach((fn) => fn()));
  return {
    addEventListener: vi.fn(),
    setInterval: vi.fn(),
    onInvalidated: vi.fn((fn: () => void) => teardowns.push(fn)),
  } as TestCtx & ContentScriptContext;
}

function getRegisteredListener(
  ctx: TestCtx & ContentScriptContext,
  event: string,
): (() => void) | undefined {
  return (ctx.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
    ([, registeredEvent]) => registeredEvent === event,
  )?.[2] as (() => void) | undefined;
}

function getRuntimeMessages(type: string): Array<Record<string, unknown>> {
  return runtimeSendMessageMock.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.type === type);
}

beforeEach(() => {
  vi.resetModules();
  resolveAccountForRepoMock.mockReset();
  listAccountsMock.mockReset().mockResolvedValue([]);
  getPreferencesMock.mockReset();
  runtimeSendMessageMock.mockReset();
  getPreferencesMock.mockResolvedValue({
    version: 1,
    showStateBadge: true,
    showReviewerName: false,
    openPullsOnly: true,
  });
  capturedStorageListener = null;
  pendingTeardowns = [];

  vi.stubGlobal("browser", {
    storage: {
      onChanged: {
        addListener: vi.fn((listener: StorageListener) => {
          capturedStorageListener = listener;
        }),
        removeListener: vi.fn(),
      },
    },
    runtime: {
      sendMessage: runtimeSendMessageMock,
    },
  });

  document.head.innerHTML = "";
  document.body.innerHTML = `
    <div class="js-issue-row" id="issue_42">
      <a class="Link--primary" href="/cinev/shotloom/pull/42">PR #42</a>
      <div class="d-flex mt-1 text-small color-fg-muted"></div>
    </div>
  `;
  window.history.replaceState({}, "", "/cinev/shotloom/pulls");
});

afterEach(() => {
  pendingTeardowns.forEach((fn) => fn());
  pendingTeardowns = [];
  vi.unstubAllGlobals();
});

describe("bootReviewerListPage", () => {
  it("rerenders on preferences change without refetching reviewer data", async () => {
    resolveAccountForRepoMock.mockResolvedValue(null);
    const summary: PullReviewerSummary = {
      status: "ok",
      requestedUsers: [{ login: "alice", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [],
    };
    runtimeSendMessageMock.mockImplementation((message: { type?: string }) => {
      if (message.type === "fetchPullReviewerMetadataBatch") {
        return Promise.resolve({ ok: true, metadata: [] });
      }
      return Promise.resolve({ ok: true, summary });
    });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();
    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(1);
    expect(document.querySelector("a.ghpsr-pill")).toBeNull();
    expect(document.querySelector("a.ghpsr-avatar")).not.toBeNull();

    getPreferencesMock.mockResolvedValueOnce({
      version: 1,
      showStateBadge: true,
      showReviewerName: true,
      openPullsOnly: true,
    });
    capturedStorageListener!(
      {
        preferences: {
          oldValue: {
            version: 1,
            showStateBadge: true,
            showReviewerName: false,
            openPullsOnly: true,
          },
          newValue: {
            version: 1,
            showStateBadge: true,
            showReviewerName: true,
            openPullsOnly: true,
          },
        },
      },
      "local",
    );

    await flushMicrotasks();
    await flushMicrotasks();

    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(1);
    expect(document.querySelector("a.ghpsr-pill")).not.toBeNull();
  });

  it("clears the reviewer cache on settings (accounts) change", async () => {
    resolveAccountForRepoMock.mockResolvedValue(null);
    const summary: PullReviewerSummary = {
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [],
    };
    runtimeSendMessageMock.mockImplementation((message: { type?: string }) => {
      if (message.type === "fetchPullReviewerMetadataBatch") {
        return Promise.resolve({ ok: true, metadata: [] });
      }
      return Promise.resolve({ ok: true, summary });
    });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();
    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(1);

    capturedStorageListener!(
      {
        settings: {
          oldValue: { version: 2, accounts: [] },
          newValue: { version: 2, accounts: [] },
        },
      },
      "local",
    );

    await flushMicrotasks();
    await flushMicrotasks();

    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(2);
  });

  it("sends reviewer fetch requests through the background runtime contract", async () => {
    const summary: PullReviewerSummary = {
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [],
    };

    resolveAccountForRepoMock.mockResolvedValueOnce({
      id: "acc-1",
      login: "hon454",
      token: "ghu_old",
      refreshToken: "ghr_old",
    });
    runtimeSendMessageMock.mockImplementation((message: { type?: string }) => {
      if (message.type === "fetchPullReviewerMetadataBatch") {
        return Promise.resolve({ ok: true, metadata: [] });
      }
      return Promise.resolve({ ok: true, summary });
    });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();

    expect(runtimeSendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "fetchPullReviewerMetadataBatch",
        owner: "cinev",
        repo: "shotloom",
        accountId: "acc-1",
        requestId: expect.any(String),
      }),
    );
    expect(runtimeSendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "fetchPullReviewerSummary",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
        requestId: expect.any(String),
      }),
    );
    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(1);
  });

  it("requests page-level pull metadata once and reuses it for matching row summaries", async () => {
    document.body.innerHTML = `
      <div class="js-issue-row" id="issue_42">
        <a class="Link--primary" href="/cinev/shotloom/pull/42">PR #42</a>
        <div class="d-flex mt-1 text-small color-fg-muted"></div>
      </div>
      <div class="js-issue-row" id="issue_41">
        <a class="Link--primary" href="/cinev/shotloom/pull/41">PR #41</a>
        <div class="d-flex mt-1 text-small color-fg-muted"></div>
      </div>
    `;
    resolveAccountForRepoMock.mockResolvedValue(null);
    const summary: PullReviewerSummary = {
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [],
    };
    runtimeSendMessageMock.mockImplementation((message: { type?: string }) => {
      if (message.type === "fetchPullReviewerMetadataBatch") {
        return Promise.resolve({
          ok: true,
          metadata: [
            {
              number: "42",
              authorLogin: "cinev",
              requestedUsers: [{ login: "alice", avatarUrl: null }],
              requestedTeams: ["platform"],
            },
          ],
        });
      }
      return Promise.resolve({ ok: true, summary });
    });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const metadataCall = runtimeSendMessageMock.mock.calls.find(
      ([message]) => message.type === "fetchPullReviewerMetadataBatch",
    )?.[0];
    const summaryCalls = runtimeSendMessageMock.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "fetchPullReviewerSummary");

    expect(metadataCall).toMatchObject({
      type: "fetchPullReviewerMetadataBatch",
      owner: "cinev",
      repo: "shotloom",
      accountId: null,
      requestId: expect.any(String),
    });
    expect(summaryCalls).toHaveLength(2);
    expect(
      summaryCalls.find((message) => message.pullNumber === "42"),
    ).toMatchObject({
      pullMetadata: {
        number: "42",
        authorLogin: "cinev",
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        requestedTeams: ["platform"],
      },
    });
    expect(
      summaryCalls.find((message) => message.pullNumber === "41"),
    ).not.toHaveProperty("pullMetadata");
  });

  it("does not flash loading text on a cache-hit re-render", async () => {
    resolveAccountForRepoMock.mockResolvedValue(null);
    const summary: PullReviewerSummary = {
      status: "ok",
      requestedUsers: [{ login: "alice", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [],
    };

    // Pre-seed the cache before bootReviewerListPage runs so processRow hits
    // the cache branch on the very first call.
    const {
      buildReviewerCacheKey,
      setCachedReviewerSummary,
      clearReviewerCache,
    } = await import("../src/cache/reviewer-cache");
    clearReviewerCache();
    setCachedReviewerSummary(
      buildReviewerCacheKey("cinev", "shotloom", "42"),
      summary,
    );

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();

    expect(runtimeSendMessageMock).not.toHaveBeenCalled();
    // The row should render reviewer chips straight from cache; no loading text.
    expect(document.body.textContent).not.toContain("Loading reviewers");
    expect(document.querySelector("a.ghpsr-avatar")).not.toBeNull();

    clearReviewerCache();
  });

  it("renders stale cached reviewers immediately then revalidates and rerenders the row", async () => {
    getPreferencesMock.mockResolvedValue({
      version: 1,
      showStateBadge: true,
      showReviewerName: true,
      openPullsOnly: true,
    });
    resolveAccountForRepoMock.mockResolvedValue(null);

    let resolveSummary: ((summary: PullReviewerSummary) => void) | null = null;
    runtimeSendMessageMock.mockImplementation((message: { type?: string }) => {
      if (message.type === "fetchPullReviewerMetadataBatch") {
        return Promise.resolve({ ok: true, metadata: [] });
      }
      if (message.type === "fetchPullReviewerSummary") {
        return new Promise<{ ok: true; summary: PullReviewerSummary }>(
          (resolve) => {
            resolveSummary = (summary) => resolve({ ok: true, summary });
          },
        );
      }
      return Promise.resolve(undefined);
    });

    const {
      buildReviewerCacheKey,
      clearReviewerCache,
      markReviewerCacheStale,
      setCachedReviewerSummary,
    } = await import("../src/cache/reviewer-cache");
    const cacheKey = buildReviewerCacheKey("cinev", "shotloom", "42");
    clearReviewerCache();
    setCachedReviewerSummary(
      cacheKey,
      {
        status: "ok",
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        requestedTeams: [],
        completedReviews: [],
      },
      { fetchedAt: 10_000 },
    );
    markReviewerCacheStale(cacheKey);

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();

    expect(document.body.textContent).toContain("@alice");
    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(1);

    resolveSummary!({
      status: "ok",
      requestedUsers: [{ login: "bob", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(document.body.textContent).not.toContain("@alice");
    expect(document.body.textContent).toContain("@bob");

    clearReviewerCache();
  });

  it("treats same-repository render events as reviewer cache revalidation triggers", async () => {
    getPreferencesMock.mockResolvedValue({
      version: 1,
      showStateBadge: true,
      showReviewerName: true,
      openPullsOnly: true,
    });
    resolveAccountForRepoMock.mockResolvedValue(null);

    let resolveSummary: ((summary: PullReviewerSummary) => void) | null = null;
    runtimeSendMessageMock.mockImplementation((message: { type?: string }) => {
      if (message.type === "fetchPullReviewerMetadataBatch") {
        return Promise.resolve({ ok: true, metadata: [] });
      }
      if (message.type === "fetchPullReviewerSummary") {
        return new Promise<{ ok: true; summary: PullReviewerSummary }>(
          (resolve) => {
            resolveSummary = (summary) => resolve({ ok: true, summary });
          },
        );
      }
      return Promise.resolve(undefined);
    });

    const {
      buildReviewerCacheKey,
      clearReviewerCache,
      setCachedReviewerSummary,
    } = await import("../src/cache/reviewer-cache");
    clearReviewerCache();
    setCachedReviewerSummary(
      buildReviewerCacheKey("cinev", "shotloom", "42"),
      {
        status: "ok",
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        requestedTeams: [],
        completedReviews: [],
      },
      { fetchedAt: Date.now() },
    );

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    const ctx = makeCtx();
    bootReviewerListPage(ctx);

    await flushMicrotasks();
    await flushMicrotasks();

    expect(document.body.textContent).toContain("@alice");
    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(0);

    getRegisteredListener(ctx, "turbo:render")?.();

    await flushMicrotasks();
    await flushMicrotasks();

    expect(document.body.textContent).toContain("@alice");
    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(1);

    resolveSummary!({
      status: "ok",
      requestedUsers: [{ login: "carol", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(document.body.textContent).not.toContain("@alice");
    expect(document.body.textContent).toContain("@carol");

    clearReviewerCache();
  });

  it("only revalidates mutated existing rows when the row fingerprint changes", async () => {
    getPreferencesMock.mockResolvedValue({
      version: 1,
      showStateBadge: true,
      showReviewerName: true,
      openPullsOnly: true,
    });
    resolveAccountForRepoMock.mockResolvedValue(null);

    let resolveSummary: ((summary: PullReviewerSummary) => void) | null = null;
    runtimeSendMessageMock.mockImplementation((message: { type?: string }) => {
      if (message.type === "fetchPullReviewerMetadataBatch") {
        return Promise.resolve({ ok: true, metadata: [] });
      }
      if (message.type === "fetchPullReviewerSummary") {
        return new Promise<{ ok: true; summary: PullReviewerSummary }>(
          (resolve) => {
            resolveSummary = (summary) => resolve({ ok: true, summary });
          },
        );
      }
      return Promise.resolve(undefined);
    });

    const {
      buildReviewerCacheKey,
      clearReviewerCache,
      setCachedReviewerSummary,
    } = await import("../src/cache/reviewer-cache");
    clearReviewerCache();
    setCachedReviewerSummary(
      buildReviewerCacheKey("cinev", "shotloom", "42"),
      {
        status: "ok",
        requestedUsers: [{ login: "alice", avatarUrl: null }],
        requestedTeams: [],
        completedReviews: [],
      },
      { fetchedAt: Date.now() },
    );

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();

    const link = document.querySelector<HTMLAnchorElement>("a.Link--primary")!;
    link.setAttribute("data-hovercard-url", "/cinev/shotloom/pull/42");

    await flushMicrotasks();
    await flushMicrotasks();

    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(0);

    link.setAttribute("href", "/cinev/shotloom/pull/42?updated=1");

    await flushMicrotasks();
    await flushMicrotasks();

    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(1);

    resolveSummary!({
      status: "ok",
      requestedUsers: [{ login: "dana", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(document.body.textContent).toContain("@dana");

    clearReviewerCache();
  });

  it("aborts in-flight summary fetches on storage (accounts) change and drops the late result", async () => {
    resolveAccountForRepoMock.mockResolvedValue(null);

    let resolveFetch: ((summary: PullReviewerSummary) => void) | null = null;
    let summaryRequestCount = 0;
    runtimeSendMessageMock.mockImplementation((message: { type?: string }) => {
      if (message.type === "fetchPullReviewerMetadataBatch") {
        return Promise.resolve({ ok: true, metadata: [] });
      }
      if (message.type === "cancelPullReviewerSummary") {
        return Promise.resolve(undefined);
      }
      summaryRequestCount += 1;
      if (summaryRequestCount === 1) {
        return new Promise<{ ok: true; summary: PullReviewerSummary }>(
          (resolve) => {
            resolveFetch = (summary) => resolve({ ok: true, summary });
          },
        );
      }
      return new Promise<void>(() => {});
    });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();

    capturedStorageListener!(
      {
        settings: {
          oldValue: { version: 4, accountIds: [] },
          newValue: { version: 4, accountIds: ["acc-1"] },
        },
      },
      "local",
    );

    await flushMicrotasks();

    // The stale fetch resolves AFTER the abort — it must not poison the cache
    // and must not render anything into the mount.
    const latePayload: PullReviewerSummary = {
      status: "ok",
      requestedUsers: [{ login: "ghost", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [],
    };
    resolveFetch!(latePayload);

    await flushMicrotasks();
    await flushMicrotasks();

    expect(getRuntimeMessages("cancelPullReviewerSummary")[0]).toMatchObject({
      type: "cancelPullReviewerSummary",
      requestId: expect.any(String),
    });
    expect(getRuntimeMessages("fetchPullReviewerSummary")[1]).toMatchObject({
      type: "fetchPullReviewerSummary",
      requestId: expect.any(String),
    });

    // The aborted fetch must not have written its summary into the cache.
    // Easiest proxy: the mount should still show the loading text from the
    // second (pending) fetch, not a rendered reviewer for "ghost".
    expect(document.body.textContent).not.toContain("ghost");
    // Nothing should have rendered the reviewer chip for the aborted login.
    expect(document.querySelector("a.ghpsr-avatar")).toBeNull();
  });

  it("shows loading again after a failed refetch clears a previously rendered row", async () => {
    resolveAccountForRepoMock.mockResolvedValue(null);
    const summaryResponses: unknown[] = [
      {
        ok: true,
        summary: {
          status: "ok",
          requestedUsers: [{ login: "alice", avatarUrl: null }],
          requestedTeams: [],
          completedReviews: [],
        },
      },
    ];
    runtimeSendMessageMock.mockImplementation((message: { type?: string }) => {
      if (message.type === "fetchPullReviewerMetadataBatch") {
        return Promise.resolve({ ok: true, metadata: [] });
      }
      if (message.type === "cancelPullReviewerSummary") {
        return Promise.resolve(undefined);
      }
      const response = summaryResponses.shift();
      if (response != null) {
        return Promise.resolve(response);
      }
      return new Promise<void>(() => {});
    });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();
    expect(document.querySelector("a.ghpsr-avatar")).not.toBeNull();

    summaryResponses.push({
      ok: false,
      error: { kind: "unknown", status: null, message: "boom" },
    });
    capturedStorageListener!(
      {
        settings: {
          oldValue: { version: 4, accountIds: [] },
          newValue: { version: 4, accountIds: ["acc-1"] },
        },
      },
      "local",
    );

    await flushMicrotasks();
    await flushMicrotasks();
    expect(document.body.textContent).not.toContain("alice");
    expect(document.body.textContent).not.toContain("Loading reviewers");

    capturedStorageListener!(
      {
        settings: {
          oldValue: { version: 4, accountIds: ["acc-1"] },
          newValue: { version: 4, accountIds: ["acc-2"] },
        },
      },
      "local",
    );

    await flushMicrotasks();

    expect(document.body.textContent).toContain("Loading reviewers");
  });

  it("aborts in-flight summary fetches when navigation leaves the pull-list route", async () => {
    resolveAccountForRepoMock.mockResolvedValue(null);

    runtimeSendMessageMock
      .mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockResolvedValueOnce(undefined);

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    const ctx = makeCtx();
    bootReviewerListPage(ctx);

    await flushMicrotasks();
    await flushMicrotasks();

    window.history.replaceState({}, "", "/cinev/shotloom/pull/42");
    getRegisteredListener(ctx, "wxt:locationchange")?.();

    await flushMicrotasks();

    expect(runtimeSendMessageMock.mock.calls[1]?.[0]).toMatchObject({
      type: "cancelPullReviewerSummary",
      requestId: expect.any(String),
    });
  });
});
