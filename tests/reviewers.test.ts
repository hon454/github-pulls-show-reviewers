// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PullReviewerSummary } from "../src/github/api";
import type * as PreferencesModule from "../src/storage/preferences";

const fetchPullReviewerSummaryMock = vi.fn();
const resolveAccountForRepoMock = vi.fn();
const markAccountInvalidatedMock = vi.fn();
const getPreferencesMock = vi.fn();

vi.mock("../src/github/api", () => ({
  fetchPullReviewerSummary: fetchPullReviewerSummaryMock,
}));

vi.mock("../src/storage/accounts", () => ({
  resolveAccountForRepo: resolveAccountForRepoMock,
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
  markAccountInvalidatedMock.mockReset();
  getPreferencesMock.mockReset();
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
  it("invalidates the matched account when GitHub rejects it with 401", async () => {
    resolveAccountForRepoMock.mockResolvedValue({
      id: "acc-1",
      login: "hon454",
      token: "ghu_abc",
    });
    fetchPullReviewerSummaryMock.mockRejectedValue({ status: 401 });

    const { bootReviewerListPage } = await import("../src/features/reviewers");
    bootReviewerListPage(makeCtx());

    await flushMicrotasks();
    await flushMicrotasks();

    expect(markAccountInvalidatedMock).toHaveBeenCalledWith("acc-1", "revoked");
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
});
