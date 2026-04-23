// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PullReviewerSummary } from "../src/github/api";
import type * as PreferencesModule from "../src/storage/preferences";

const fetchPullReviewerSummaryMock = vi.fn();
const resolveAccountForRepoMock = vi.fn();
const getAccountByIdMock = vi.fn();
const markAccountInvalidatedMock = vi.fn();
const getPreferencesMock = vi.fn();
const runtimeSendMessageMock = vi.fn();

vi.mock("../src/github/api", () => ({
  fetchPullReviewerSummary: fetchPullReviewerSummaryMock,
}));

vi.mock("../src/storage/accounts", () => ({
  resolveAccountForRepo: resolveAccountForRepoMock,
  getAccountById: getAccountByIdMock,
  markAccountInvalidated: markAccountInvalidatedMock,
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

function makeCtx() {
  const teardowns: Array<() => void> = [];
  pendingTeardowns.push(() => teardowns.forEach((fn) => fn()));
  return {
    addEventListener: vi.fn(),
    setInterval: vi.fn(),
    onInvalidated: vi.fn((fn: () => void) => teardowns.push(fn)),
  } as never;
}

beforeEach(() => {
  vi.resetModules();
  fetchPullReviewerSummaryMock.mockReset();
  resolveAccountForRepoMock.mockReset();
  getAccountByIdMock.mockReset();
  markAccountInvalidatedMock.mockReset();
  getPreferencesMock.mockReset();
  runtimeSendMessageMock.mockReset();
  getPreferencesMock.mockResolvedValue({
    version: 1,
    showStateBadge: true,
    showReviewerName: false,
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
  it("marks the account revoked on 401 when there is no refresh token", async () => {
    resolveAccountForRepoMock.mockResolvedValue({
      id: "acc-1",
      login: "hon454",
      token: "ghu_abc",
      refreshToken: null,
    });
    fetchPullReviewerSummaryMock.mockRejectedValue({ status: 401 });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();

    expect(markAccountInvalidatedMock).toHaveBeenCalledWith("acc-1", "revoked");
    expect(runtimeSendMessageMock).not.toHaveBeenCalled();
  });

  it("rerenders on preferences change without refetching reviewer data", async () => {
    resolveAccountForRepoMock.mockResolvedValue(null);
    const summary: PullReviewerSummary = {
      status: "ok",
      requestedUsers: [{ login: "alice", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [],
    };
    fetchPullReviewerSummaryMock.mockResolvedValue(summary);

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();
    expect(fetchPullReviewerSummaryMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector("a.ghpsr-pill")).toBeNull();
    expect(document.querySelector("a.ghpsr-avatar")).not.toBeNull();

    getPreferencesMock.mockResolvedValueOnce({
      version: 1,
      showStateBadge: true,
      showReviewerName: true,
    });
    capturedStorageListener!(
      {
        preferences: {
          oldValue: { version: 1, showStateBadge: true, showReviewerName: false },
          newValue: { version: 1, showStateBadge: true, showReviewerName: true },
        },
      },
      "local",
    );

    await flushMicrotasks();
    await flushMicrotasks();

    expect(fetchPullReviewerSummaryMock).toHaveBeenCalledTimes(1);
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
    fetchPullReviewerSummaryMock.mockResolvedValue(summary);

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();
    expect(fetchPullReviewerSummaryMock).toHaveBeenCalledTimes(1);

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

    expect(fetchPullReviewerSummaryMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes the access token on 401 and retries with the new token", async () => {
    const summary: PullReviewerSummary = {
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [],
    };

    resolveAccountForRepoMock
      .mockResolvedValueOnce({
        id: "acc-1",
        login: "hon454",
        token: "ghu_old",
        refreshToken: "ghr_old",
      });
    getAccountByIdMock.mockResolvedValueOnce({
      id: "acc-1",
      login: "hon454",
      token: "ghu_new",
      refreshToken: "ghr_new",
    });

    fetchPullReviewerSummaryMock
      .mockRejectedValueOnce({ status: 401 })
      .mockResolvedValueOnce(summary);

    runtimeSendMessageMock.mockResolvedValueOnce({ ok: true, token: "ghu_new" });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(runtimeSendMessageMock).toHaveBeenCalledWith({
      type: "refreshAccessToken",
      accountId: "acc-1",
    });
    expect(fetchPullReviewerSummaryMock).toHaveBeenCalledTimes(2);
    expect(fetchPullReviewerSummaryMock.mock.calls[1][0]).toMatchObject({
      githubToken: "ghu_new",
    });
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("does not invalidate when the BG refresh returns terminal=true (BG already marked the account)", async () => {
    resolveAccountForRepoMock.mockResolvedValue({
      id: "acc-1",
      login: "hon454",
      token: "ghu_old",
      refreshToken: "ghr_old",
    });
    fetchPullReviewerSummaryMock.mockRejectedValue({ status: 401 });
    runtimeSendMessageMock.mockResolvedValueOnce({ ok: false, terminal: true });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();

    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("does not invalidate on a transient refresh failure", async () => {
    resolveAccountForRepoMock.mockResolvedValue({
      id: "acc-1",
      login: "hon454",
      token: "ghu_old",
      refreshToken: "ghr_old",
    });
    fetchPullReviewerSummaryMock.mockRejectedValue({ status: 401 });
    runtimeSendMessageMock.mockResolvedValueOnce({ ok: false, terminal: false });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();

    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("aborts in-flight summary fetches on storage (accounts) change and drops the late result", async () => {
    resolveAccountForRepoMock.mockResolvedValue(null);

    // Capture the signal so we can assert abort() is called by the boot code.
    let capturedSignal: AbortSignal | null = null;
    let resolveFetch: ((summary: PullReviewerSummary) => void) | null = null;
    fetchPullReviewerSummaryMock.mockImplementationOnce(
      (input: { signal?: AbortSignal }) => {
        capturedSignal = input.signal ?? null;
        return new Promise<PullReviewerSummary>((resolve) => {
          resolveFetch = resolve;
        });
      },
    );

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);

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
    expect(capturedSignal!.aborted).toBe(true);

    // The stale fetch resolves AFTER the abort — it must not poison the cache
    // and must not render anything into the mount.
    const latePayload: PullReviewerSummary = {
      status: "ok",
      requestedUsers: [{ login: "ghost", avatarUrl: null }],
      requestedTeams: [],
      completedReviews: [],
    };
    // Second fetch (triggered by the storage change) also pends — no render.
    fetchPullReviewerSummaryMock.mockImplementationOnce(
      () => new Promise<PullReviewerSummary>(() => {}),
    );
    resolveFetch!(latePayload);

    await flushMicrotasks();
    await flushMicrotasks();

    // The aborted fetch must not have written its summary into the cache.
    // Easiest proxy: the mount should still show the loading text from the
    // second (pending) fetch, not a rendered reviewer for "ghost".
    expect(document.body.textContent).not.toContain("ghost");
    // Nothing should have rendered the reviewer chip for the aborted login.
    expect(document.querySelector("a.ghpsr-avatar")).toBeNull();
  });

  it("marks the account revoked when the retry after refresh also returns 401", async () => {
    resolveAccountForRepoMock
      .mockResolvedValueOnce({
        id: "acc-1",
        login: "hon454",
        token: "ghu_old",
        refreshToken: "ghr_old",
      });
    getAccountByIdMock.mockResolvedValueOnce({
      id: "acc-1",
      login: "hon454",
      token: "ghu_new",
      refreshToken: "ghr_new",
    });
    fetchPullReviewerSummaryMock
      .mockRejectedValueOnce({ status: 401 })
      .mockRejectedValueOnce({ status: 401 });
    runtimeSendMessageMock.mockResolvedValueOnce({ ok: true, token: "ghu_new" });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(markAccountInvalidatedMock).toHaveBeenCalledWith("acc-1", "revoked");
  });
});
