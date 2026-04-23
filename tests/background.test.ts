import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GithubApiModule from "../src/github/api";

const refreshAccountTokenMock = vi.fn();
const fetchPullReviewerSummaryMock = vi.fn();
const getAccountByIdMock = vi.fn();
const markAccountInvalidatedMock = vi.fn();
const createRefreshCoordinatorMock = vi.fn(() => ({
  refreshAccountToken: refreshAccountTokenMock,
}));
const getGitHubAppConfigMock = vi.fn(() => ({ clientId: "test-client-id" }));

vi.mock("../src/auth/refresh-coordinator", () => ({
  createRefreshCoordinator: createRefreshCoordinatorMock,
}));

vi.mock("../src/config/github-app", () => ({
  getGitHubAppConfig: getGitHubAppConfigMock,
}));

vi.mock("../src/storage/accounts", () => ({
  getAccountById: getAccountByIdMock,
  markAccountInvalidated: markAccountInvalidatedMock,
}));

vi.mock("../src/github/api", async () => {
  const actual = await vi.importActual<typeof GithubApiModule>(
    "../src/github/api",
  );
  return {
    ...actual,
    fetchPullReviewerSummary: fetchPullReviewerSummaryMock,
  };
});

type MessageSender = { id?: string };
type MessageListener = (
  message: unknown,
  sender: MessageSender | undefined,
  sendResponse: () => void,
) => unknown;

const SELF_RUNTIME_ID = "self-extension-id";

let capturedMessageListener: MessageListener | null;

beforeEach(() => {
  vi.resetModules();
  refreshAccountTokenMock.mockReset();
  fetchPullReviewerSummaryMock.mockReset();
  getAccountByIdMock.mockReset();
  markAccountInvalidatedMock.mockReset();
  refreshAccountTokenMock.mockResolvedValue({ ok: true, token: "new-token" });
  createRefreshCoordinatorMock.mockClear();
  getGitHubAppConfigMock.mockClear();
  capturedMessageListener = null;

  vi.stubGlobal("defineBackground", (main: () => void) => ({ main }));
  vi.stubGlobal("browser", {
    runtime: {
      id: SELF_RUNTIME_ID,
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((listener: MessageListener) => {
          capturedMessageListener = listener;
        }),
      },
      openOptionsPage: vi.fn(),
    },
    action: {
      onClicked: { addListener: vi.fn() },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function bootBackground(): Promise<MessageListener> {
  const { default: background } = await import("../entrypoints/background");
  background.main!();
  if (capturedMessageListener == null) {
    throw new Error("background did not register a runtime.onMessage listener");
  }
  return capturedMessageListener;
}

describe("background runtime.onMessage handler", () => {
  it("dispatches valid refresh messages that originate from this extension", async () => {
    const listener = await bootBackground();

    const result = listener(
      { type: "refreshAccessToken", accountId: "acc-1" },
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    expect(refreshAccountTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1");
    await expect(result as Promise<unknown>).resolves.toEqual({
      ok: true,
      token: "new-token",
    });
  });

  it("rejects valid refresh messages from a different extension id", async () => {
    const listener = await bootBackground();

    const result = listener(
      { type: "refreshAccessToken", accountId: "acc-1" },
      { id: "some-other-extension-id" },
      () => {},
    );

    expect(result).toBeUndefined();
    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
  });

  it("rejects malformed envelopes even when sent from this extension", async () => {
    const listener = await bootBackground();

    const missingAccountId = listener(
      { type: "refreshAccessToken" },
      { id: SELF_RUNTIME_ID },
      () => {},
    );
    const wrongType = listener(
      { type: "somethingElse", accountId: "acc-1" },
      { id: SELF_RUNTIME_ID },
      () => {},
    );
    const notAnObject = listener(
      "refreshAccessToken",
      { id: SELF_RUNTIME_ID },
      () => {},
    );
    const emptyReviewerFetch = listener(
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-1",
        owner: "",
        repo: "shotloom",
        pullNumber: "42",
        accountId: null,
      },
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    expect(missingAccountId).toBeUndefined();
    expect(wrongType).toBeUndefined();
    expect(notAnObject).toBeUndefined();
    expect(emptyReviewerFetch).toBeUndefined();
    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
  });

  it("dispatches reviewer fetch messages through the background handler", async () => {
    const listener = await bootBackground();
    const summary = {
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [],
    };
    getAccountByIdMock.mockResolvedValue({
      id: "acc-1",
      token: "ghu_123",
      refreshToken: "ghr_123",
    });
    fetchPullReviewerSummaryMock.mockResolvedValue(summary);

    const result = listener(
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-1",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
      },
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    await expect(result as Promise<unknown>).resolves.toEqual({
      ok: true,
      summary,
    });
    expect(fetchPullReviewerSummaryMock).toHaveBeenCalledWith({
      owner: "cinev",
      repo: "shotloom",
      pullNumber: "42",
      githubToken: "ghu_123",
      signal: expect.any(AbortSignal),
    });
  });

  it("refreshes on reviewer fetch 401 and retries with the updated token", async () => {
    const listener = await bootBackground();
    const summary = {
      status: "ok",
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [],
    };
    getAccountByIdMock
      .mockResolvedValueOnce({
        id: "acc-1",
        token: "ghu_old",
        refreshToken: "ghr_old",
      })
      .mockResolvedValueOnce({
        id: "acc-1",
        token: "ghu_new",
        refreshToken: "ghr_new",
      });
    fetchPullReviewerSummaryMock
      .mockRejectedValueOnce({ status: 401 })
      .mockResolvedValueOnce(summary);

    const result = listener(
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-1",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
      },
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    await expect(result as Promise<unknown>).resolves.toEqual({
      ok: true,
      summary,
    });
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1");
    expect(fetchPullReviewerSummaryMock).toHaveBeenCalledTimes(2);
    expect(fetchPullReviewerSummaryMock.mock.calls[1][0]).toMatchObject({
      githubToken: "ghu_new",
    });
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("returns the original error without invalidating when refresh is transiently unavailable", async () => {
    const listener = await bootBackground();
    getAccountByIdMock.mockResolvedValue({
      id: "acc-1",
      token: "ghu_old",
      refreshToken: "ghr_old",
    });
    refreshAccountTokenMock.mockResolvedValueOnce({ ok: false, terminal: false });
    fetchPullReviewerSummaryMock.mockRejectedValueOnce({ status: 401 });

    const result = listener(
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-1",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
      },
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    await expect(result as Promise<unknown>).resolves.toMatchObject({
      ok: false,
      error: { kind: "unknown", status: 401 },
    });
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1");
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("marks the account revoked when reviewer fetch 401s without a refresh token", async () => {
    const listener = await bootBackground();
    getAccountByIdMock.mockResolvedValue({
      id: "acc-1",
      token: "ghu_old",
      refreshToken: null,
    });
    fetchPullReviewerSummaryMock.mockRejectedValueOnce({ status: 401 });

    const result = listener(
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-1",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
      },
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    await expect(result as Promise<unknown>).resolves.toMatchObject({
      ok: false,
      error: { kind: "unknown", status: 401 },
    });
    expect(markAccountInvalidatedMock).toHaveBeenCalledWith("acc-1", "revoked");
    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
  });

  it("marks the account revoked when the retry after refresh also returns 401", async () => {
    const listener = await bootBackground();
    getAccountByIdMock
      .mockResolvedValueOnce({
        id: "acc-1",
        token: "ghu_old",
        refreshToken: "ghr_old",
      })
      .mockResolvedValueOnce({
        id: "acc-1",
        token: "ghu_new",
        refreshToken: "ghr_new",
      });
    fetchPullReviewerSummaryMock
      .mockRejectedValueOnce({ status: 401 })
      .mockRejectedValueOnce({ status: 401 });

    const result = listener(
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-1",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
      },
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    await expect(result as Promise<unknown>).resolves.toMatchObject({
      ok: false,
      error: { kind: "unknown", status: 401 },
    });
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1");
    expect(markAccountInvalidatedMock).toHaveBeenCalledWith("acc-1", "revoked");
  });

  it("aborts an in-flight reviewer fetch when a cancel message arrives", async () => {
    const listener = await bootBackground();
    getAccountByIdMock.mockResolvedValue({
      id: "acc-1",
      token: "ghu_old",
      refreshToken: "ghr_old",
    });

    let capturedSignal: AbortSignal | null = null;
    fetchPullReviewerSummaryMock.mockImplementationOnce(
      (input: { signal?: AbortSignal }) => {
        capturedSignal = input.signal ?? null;
        return new Promise(() => {});
      },
    );

    void listener(
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-cancel",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
      },
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    await Promise.resolve();
    expect(capturedSignal).not.toBeNull();
    const signal = capturedSignal as AbortSignal | null;
    if (signal == null) {
      throw new Error("expected background fetch signal");
    }
    expect(signal.aborted).toBe(false);

    const cancelResult = listener(
      {
        type: "cancelPullReviewerSummary",
        requestId: "req-cancel",
      },
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    expect(cancelResult).toBeUndefined();
    expect(signal.aborted).toBe(true);
  });
});
