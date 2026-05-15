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

  it("uses the connected owner account after a failed no-token metadata fetch", async () => {
    document.body.innerHTML = `
      <div class="js-issue-row" id="issue_42">
        <a class="Link--primary" href="/hon454/private-repo/pull/42">PR #42</a>
        <div class="d-flex mt-1 text-small color-fg-muted"></div>
      </div>
    `;
    window.history.replaceState({}, "", "/hon454/private-repo/pulls");

    resolveAccountForRepoMock.mockResolvedValue(null);
    listAccountsMock.mockResolvedValue([
      {
        id: "acc-owner",
        login: "hon454",
        avatarUrl: null,
        token: "ghu_owner",
        createdAt: 1,
        installations: [],
        installationsRefreshedAt: 1,
        invalidated: false,
        invalidatedReason: null,
        refreshToken: null,
        expiresAt: null,
        refreshTokenExpiresAt: null,
      },
    ]);

    const summary: PullReviewerSummary = {
      status: "ok",
      requestedUsers: [{ login: "alice", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [],
    };
    const rateLimitError = {
      kind: "github-api" as const,
      status: 429,
      failures: [
        {
          status: 429,
          endpoint: null,
          rateLimited: true,
          rateLimit: {
            limit: 60,
            remaining: 0,
            resource: "core",
            resetAt: 1_700_000_000,
          },
        },
      ],
    };
    runtimeSendMessageMock.mockImplementation(
      (message: { type?: string; accountId?: string | null }) => {
        if (
          message.type === "fetchPullReviewerMetadataBatch" &&
          message.accountId == null
        ) {
          return Promise.resolve({ ok: false, error: rateLimitError });
        }
        if (
          message.type === "fetchPullReviewerMetadataBatch" &&
          message.accountId === "acc-owner"
        ) {
          return Promise.resolve({ ok: true, metadata: [] });
        }
        if (
          message.type === "fetchPullReviewerSummary" &&
          message.accountId == null
        ) {
          return Promise.resolve({ ok: false, error: rateLimitError });
        }
        if (
          message.type === "fetchPullReviewerSummary" &&
          message.accountId === "acc-owner"
        ) {
          return Promise.resolve({ ok: true, summary });
        }
        return Promise.resolve(undefined);
      },
    );

    const onRowFailure = vi.fn();
    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx(), { onRowFailure });

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      getRuntimeMessages("fetchPullReviewerMetadataBatch").map(
        (message) => message.accountId,
      ),
    ).toEqual([null, "acc-owner"]);
    expect(
      getRuntimeMessages("fetchPullReviewerSummary").map(
        (message) => message.accountId,
      ),
    ).toEqual(["acc-owner"]);
    expect(onRowFailure).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Reviewers:");
    expect(
      document.querySelector('a.ghpsr-avatar[title*="@alice"]'),
    ).not.toBeNull();
  });

  it("reports fallback account failures as signed-in failures", async () => {
    document.body.innerHTML = `
      <div class="js-issue-row" id="issue_42">
        <a class="Link--primary" href="/hon454/private-repo/pull/42">PR #42</a>
        <div class="d-flex mt-1 text-small color-fg-muted"></div>
      </div>
    `;
    window.history.replaceState({}, "", "/hon454/private-repo/pulls");

    const account = {
      id: "acc-owner",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_owner",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    };
    resolveAccountForRepoMock.mockResolvedValue(null);
    listAccountsMock.mockResolvedValue([account]);

    const rateLimitError = {
      kind: "github-api" as const,
      status: 429,
      failures: [{ status: 429, endpoint: null, rateLimited: true }],
    };
    const notFoundError = {
      kind: "github-api" as const,
      status: 404,
      failures: [{ status: 404, endpoint: null, rateLimited: false }],
    };
    runtimeSendMessageMock.mockImplementation(
      (message: { type?: string; accountId?: string | null }) => {
        if (
          message.type === "fetchPullReviewerMetadataBatch" &&
          message.accountId == null
        ) {
          return Promise.resolve({ ok: false, error: rateLimitError });
        }
        if (
          message.type === "fetchPullReviewerMetadataBatch" &&
          message.accountId === "acc-owner"
        ) {
          return Promise.resolve({ ok: true, metadata: [] });
        }
        if (
          message.type === "fetchPullReviewerSummary" &&
          message.accountId == null
        ) {
          return Promise.resolve({ ok: false, error: rateLimitError });
        }
        if (
          message.type === "fetchPullReviewerSummary" &&
          message.accountId === "acc-owner"
        ) {
          return Promise.resolve({ ok: false, error: notFoundError });
        }
        return Promise.resolve(undefined);
      },
    );

    const onRowFailure = vi.fn();
    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx(), { onRowFailure });

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(onRowFailure).toHaveBeenCalledWith({
      owner: "hon454",
      repo: "private-repo",
      account,
      error: expect.objectContaining({
        envelope: notFoundError,
      }),
    });
  });

  it("reuses a page fallback account after a failed no-token metadata request", async () => {
    document.body.innerHTML = `
      <div class="js-issue-row" id="issue_42">
        <a class="Link--primary" href="/hon454/private-repo/pull/42">PR #42</a>
        <div class="d-flex mt-1 text-small color-fg-muted"></div>
      </div>
      <div class="js-issue-row" id="issue_41">
        <a class="Link--primary" href="/hon454/private-repo/pull/41">PR #41</a>
        <div class="d-flex mt-1 text-small color-fg-muted"></div>
      </div>
    `;
    window.history.replaceState({}, "", "/hon454/private-repo/pulls");

    const account = {
      id: "acc-owner",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_owner",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    };
    resolveAccountForRepoMock.mockResolvedValue(null);
    listAccountsMock.mockResolvedValue([account]);

    const rateLimitError = {
      kind: "github-api" as const,
      status: 429,
      failures: [{ status: 429, endpoint: null, rateLimited: true }],
    };
    const summary: PullReviewerSummary = {
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [],
    };

    runtimeSendMessageMock.mockImplementation(
      (message: {
        type?: string;
        accountId?: string | null;
        pullNumber?: string;
      }) => {
        if (
          message.type === "fetchPullReviewerMetadataBatch" &&
          message.accountId == null
        ) {
          return Promise.resolve({ ok: false, error: rateLimitError });
        }
        if (
          message.type === "fetchPullReviewerMetadataBatch" &&
          message.accountId === "acc-owner"
        ) {
          return Promise.resolve({
            ok: true,
            metadata: [
              {
                number: "42",
                authorLogin: "hon454",
                requestedUsers: [],
                requestedTeams: [],
              },
              {
                number: "41",
                authorLogin: "hon454",
                requestedUsers: [],
                requestedTeams: [],
              },
            ],
          });
        }
        if (
          message.type === "fetchPullReviewerSummary" &&
          message.accountId === "acc-owner"
        ) {
          return Promise.resolve({ ok: true, summary });
        }
        if (message.type === "fetchPullReviewerSummary") {
          return Promise.resolve({ ok: false, error: rateLimitError });
        }
        return Promise.resolve(undefined);
      },
    );

    const onRowFailure = vi.fn();
    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx(), { onRowFailure });

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      getRuntimeMessages("fetchPullReviewerMetadataBatch").map(
        (message) => message.accountId,
      ),
    ).toEqual([null, "acc-owner"]);
    expect(
      getRuntimeMessages("fetchPullReviewerSummary").map(
        (message) => message.accountId,
      ),
    ).toEqual(["acc-owner", "acc-owner"]);
    expect(onRowFailure).not.toHaveBeenCalled();
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

  it("passes visible pull numbers to the page-level metadata request", async () => {
    document.body.innerHTML = `
      <div class="js-issue-row" id="issue_150">
        <a class="Link--primary" href="/cinev/shotloom/pull/150">PR #150</a>
        <div class="d-flex mt-1 text-small color-fg-muted"></div>
      </div>
      <div class="js-issue-row" id="issue_149">
        <a class="Link--primary" href="/cinev/shotloom/pull/149">PR #149</a>
        <div class="d-flex mt-1 text-small color-fg-muted"></div>
      </div>
    `;
    window.history.replaceState(
      {},
      "",
      "/cinev/shotloom/pulls?q=is%3Apr+review-requested%3Aalice",
    );
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
              number: "150",
              authorLogin: "cinev",
              requestedUsers: [],
              requestedTeams: [],
            },
            {
              number: "149",
              authorLogin: "cinev",
              requestedUsers: [],
              requestedTeams: [],
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

    expect(
      getRuntimeMessages("fetchPullReviewerMetadataBatch")[0],
    ).toMatchObject({
      targetPullNumbers: ["150", "149"],
    });
  });

  it("uses metadata-covered older visible rows without row pull fallback", async () => {
    document.body.innerHTML = `
      <div class="js-issue-row" id="issue_150">
        <a class="Link--primary" href="/cinev/shotloom/pull/150">PR #150</a>
        <div class="d-flex mt-1 text-small color-fg-muted"></div>
      </div>
      <div class="js-issue-row" id="issue_149">
        <a class="Link--primary" href="/cinev/shotloom/pull/149">PR #149</a>
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
              number: "150",
              authorLogin: "cinev",
              requestedUsers: [{ login: "alice", avatarUrl: null }],
              requestedTeams: [],
            },
            {
              number: "149",
              authorLogin: "cinev",
              requestedUsers: [],
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

    expect(getRuntimeMessages("fetchPullReviewerMetadataBatch")).toHaveLength(1);
    expect(
      getRuntimeMessages("fetchPullReviewerMetadataBatch")[0],
    ).toMatchObject({
      targetPullNumbers: ["150", "149"],
    });
    expect(
      getRuntimeMessages("fetchPullReviewerSummary").map((message) => ({
        pullNumber: message.pullNumber,
        pullMetadata: message.pullMetadata,
      })),
    ).toEqual([
      {
        pullNumber: "150",
        pullMetadata: {
          number: "150",
          authorLogin: "cinev",
          requestedUsers: [{ login: "alice", avatarUrl: null }],
          requestedTeams: [],
        },
      },
      {
        pullNumber: "149",
        pullMetadata: {
          number: "149",
          authorLogin: "cinev",
          requestedUsers: [],
          requestedTeams: ["platform"],
        },
      },
    ]);
  });

  it("short-circuits same-page row fallback after a final page metadata rate-limit failure", async () => {
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
    listAccountsMock.mockResolvedValue([]);

    const rateLimitError = {
      kind: "github-api" as const,
      status: 429,
      failures: [
        {
          status: 429,
          endpoint: "/repos/cinev/shotloom/pulls",
          rateLimited: true,
          rateLimit: {
            limit: 60,
            remaining: 0,
            resource: "core",
            resetAt: 1_700_000_000,
          },
        },
      ],
    };
    runtimeSendMessageMock.mockImplementation((message: { type?: string }) => {
      if (message.type === "fetchPullReviewerMetadataBatch") {
        return Promise.resolve({ ok: false, error: rateLimitError });
      }
      return Promise.resolve(undefined);
    });

    const onRowFailure = vi.fn();
    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx(), { onRowFailure });

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(getRuntimeMessages("fetchPullReviewerMetadataBatch")).toHaveLength(1);
    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(0);
    expect(onRowFailure).toHaveBeenCalledTimes(1);
    expect(onRowFailure).toHaveBeenCalledWith({
      owner: "cinev",
      repo: "shotloom",
      account: null,
      error: expect.objectContaining({
        envelope: rateLimitError,
      }),
    });
  });

  it("does not let an older fallback metadata failure overwrite a newer success", async () => {
    document.body.innerHTML = `
      <div class="js-issue-row" id="issue_42">
        <a class="Link--primary" href="/hon454/private-repo/pull/42">PR #42</a>
        <div class="d-flex mt-1 text-small color-fg-muted"></div>
      </div>
    `;
    window.history.replaceState({}, "", "/hon454/private-repo/pulls");

    const account = {
      id: "acc-owner",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_owner",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    };
    resolveAccountForRepoMock.mockResolvedValue(null);
    listAccountsMock.mockResolvedValue([account]);

    const rateLimitError = {
      kind: "github-api" as const,
      status: 429,
      failures: [{ status: 429, endpoint: null, rateLimited: true }],
    };
    const summary: PullReviewerSummary = {
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [],
    };

    let fallbackMetadataCalls = 0;
    let resolveFirstFallbackMetadata:
      | ((response: Record<string, unknown>) => void)
      | null = null;
    let resolveSecondFallbackMetadata:
      | ((response: Record<string, unknown>) => void)
      | null = null;

    runtimeSendMessageMock.mockImplementation(
      (message: { type?: string; accountId?: string | null }) => {
        if (
          message.type === "fetchPullReviewerMetadataBatch" &&
          message.accountId == null
        ) {
          return Promise.resolve({ ok: false, error: rateLimitError });
        }
        if (
          message.type === "fetchPullReviewerMetadataBatch" &&
          message.accountId === "acc-owner"
        ) {
          fallbackMetadataCalls += 1;
          if (fallbackMetadataCalls === 1) {
            return new Promise<Record<string, unknown>>((resolve) => {
              resolveFirstFallbackMetadata = resolve;
            });
          }
          return new Promise<Record<string, unknown>>((resolve) => {
            resolveSecondFallbackMetadata = resolve;
          });
        }
        if (message.type === "fetchPullReviewerSummary") {
          return Promise.resolve({ ok: true, summary });
        }
        return Promise.resolve(undefined);
      },
    );

    const onRowFailure = vi.fn();
    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx(), { onRowFailure });

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(fallbackMetadataCalls).toBe(1);

    document.body.insertAdjacentHTML(
      "beforeend",
      `
        <div class="js-issue-row" id="issue_41">
          <a class="Link--primary" href="/hon454/private-repo/pull/41">PR #41</a>
          <div class="d-flex mt-1 text-small color-fg-muted"></div>
        </div>
      `,
    );

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(fallbackMetadataCalls).toBe(2);

    resolveSecondFallbackMetadata!({
      ok: true,
      metadata: [
        {
          number: "42",
          authorLogin: "hon454",
          requestedUsers: [],
          requestedTeams: [],
        },
        {
          number: "41",
          authorLogin: "hon454",
          requestedUsers: [],
          requestedTeams: [],
        },
      ],
    });
    await flushMicrotasks();
    await flushMicrotasks();

    resolveFirstFallbackMetadata!({ ok: false, error: rateLimitError });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(onRowFailure).not.toHaveBeenCalled();
    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(2);
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

  it("does not revalidate existing rows when GitHub relative-time text updates", async () => {
    getPreferencesMock.mockResolvedValue({
      version: 1,
      showStateBadge: true,
      showReviewerName: true,
      openPullsOnly: true,
    });
    resolveAccountForRepoMock.mockResolvedValue(null);

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

    const metadata = document.querySelector<HTMLElement>(
      ".d-flex.mt-1.text-small.color-fg-muted",
    )!;
    metadata.innerHTML = `
      <span class="issue-meta-section">
        #42 opened <relative-time datetime="2026-05-08T02:00:00Z">30 minutes ago</relative-time> by mira
      </span>
    `;

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();

    expect(document.body.textContent).toContain("@alice");
    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(0);

    document.querySelector("relative-time")!.textContent = "31 minutes ago";

    await flushMicrotasks();
    await flushMicrotasks();

    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(0);

    clearReviewerCache();
  });

  it("revalidates mutated existing rows when metadata children are added", async () => {
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

    const metadata = document.querySelector<HTMLElement>(
      ".d-flex.mt-1.text-small.color-fg-muted",
    )!;
    const stateText = document.createElement("span");
    stateText.textContent = "Review requested";
    metadata.append(stateText);

    await flushMicrotasks();
    await flushMicrotasks();

    expect(getRuntimeMessages("fetchPullReviewerSummary")).toHaveLength(1);

    resolveSummary!({
      status: "ok",
      requestedUsers: [{ login: "erin", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [],
    });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(document.body.textContent).toContain("@erin");

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
