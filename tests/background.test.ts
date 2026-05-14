import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GithubApiModule from "../src/github/api";
import { CANCELED_REQUEST_TTL_MS } from "../src/background/reviewer-fetch";
import {
  PROACTIVE_REFRESH_ALARM_NAME,
  PROACTIVE_REFRESH_PERIOD_MINUTES,
  PROACTIVE_REFRESH_THRESHOLD_MS,
} from "../src/config/proactive-refresh";

const {
  refreshAccountTokenMock,
  fetchPullReviewerSummaryMock,
  fetchPullReviewerMetadataBatchMock,
  getAccountByIdMock,
  listAccountsMock,
  markAccountInvalidatedMock,
  createRefreshCoordinatorMock,
  refreshAccountInstallationsMock,
  createInstallationRefreshServiceMock,
  getGitHubAppConfigMock,
} = vi.hoisted(() => ({
  refreshAccountTokenMock: vi.fn(),
  fetchPullReviewerSummaryMock: vi.fn(),
  fetchPullReviewerMetadataBatchMock: vi.fn(),
  getAccountByIdMock: vi.fn(),
  listAccountsMock: vi.fn<() => Promise<unknown[]>>(),
  markAccountInvalidatedMock: vi.fn(),
  createRefreshCoordinatorMock: vi.fn(),
  refreshAccountInstallationsMock: vi.fn(),
  createInstallationRefreshServiceMock: vi.fn(),
  getGitHubAppConfigMock: vi.fn(() => ({ clientId: "test-client-id" })),
}));
createRefreshCoordinatorMock.mockImplementation(() => ({
  refreshAccountToken: refreshAccountTokenMock,
}));
createInstallationRefreshServiceMock.mockImplementation(() => ({
  refreshAccountInstallations: refreshAccountInstallationsMock,
}));

vi.mock("../src/auth/refresh-coordinator", () => ({
  createRefreshCoordinator: createRefreshCoordinatorMock,
}));

vi.mock("../src/background/installation-refresh", () => ({
  createInstallationRefreshService: createInstallationRefreshServiceMock,
}));

vi.mock("../src/config/github-app", () => ({
  getGitHubAppConfig: getGitHubAppConfigMock,
}));

vi.mock("../src/storage/accounts", () => ({
  getAccountById: getAccountByIdMock,
  listAccounts: listAccountsMock,
  markAccountInvalidated: markAccountInvalidatedMock,
}));

vi.mock("../src/github/api", async () => {
  const actual = await vi.importActual<typeof GithubApiModule>(
    "../src/github/api",
  );
  return {
    ...actual,
    fetchPullReviewerSummary: fetchPullReviewerSummaryMock,
    fetchPullReviewerMetadataBatch: fetchPullReviewerMetadataBatchMock,
  };
});

type MessageSender = { id?: string };
type MessageListener = (
  message: unknown,
  sender: MessageSender | undefined,
  sendResponse: (value?: unknown) => void,
) => unknown;

const SELF_RUNTIME_ID = "self-extension-id";

let capturedMessageListener: MessageListener | null;

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Drives the listener through Chrome's `return true` + `sendResponse`
// contract. The returned Promise resolves to whatever the listener routes
// back to the caller — either the async `sendResponse` value or the sync
// return for messages the listener does not handle.
function callListener(
  listener: MessageListener,
  message: unknown,
  sender: MessageSender | undefined,
): Promise<unknown> {
  return new Promise((resolve) => {
    const keepOpen = listener(message, sender, resolve);
    if (keepOpen !== true) {
      resolve(keepOpen);
    }
  });
}

let capturedAlarmListener: ((alarm: { name: string }) => void) | null;
const alarmsCreateMock = vi.fn(async () => undefined);

beforeEach(() => {
  vi.resetModules();
  refreshAccountTokenMock.mockReset();
  fetchPullReviewerSummaryMock.mockReset();
  fetchPullReviewerMetadataBatchMock.mockReset();
  getAccountByIdMock.mockReset();
  listAccountsMock.mockReset().mockResolvedValue([]);
  markAccountInvalidatedMock.mockReset();
  refreshAccountTokenMock.mockResolvedValue({ ok: true, token: "new-token" });
  refreshAccountInstallationsMock.mockReset().mockResolvedValue({ ok: true });
  createRefreshCoordinatorMock.mockClear();
  createInstallationRefreshServiceMock.mockClear();
  getGitHubAppConfigMock.mockClear();
  alarmsCreateMock.mockClear();
  capturedMessageListener = null;
  capturedAlarmListener = null;

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
    alarms: {
      create: alarmsCreateMock,
      get: vi.fn(async () => undefined),
      onAlarm: {
        addListener: vi.fn((listener: (alarm: { name: string }) => void) => {
          capturedAlarmListener = listener;
        }),
      },
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

    const response = await callListener(
      listener,
      { type: "refreshAccessToken", accountId: "acc-1" },
      { id: SELF_RUNTIME_ID },
    );

    expect(refreshAccountTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1");
    expect(response).toEqual({ ok: true, token: "new-token" });
  });

  it("keeps the message channel open for async dispatch", async () => {
    const listener = await bootBackground();

    const sync = listener(
      { type: "refreshAccessToken", accountId: "acc-1" },
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    expect(sync).toBe(true);
  });

  it("rejects valid refresh messages from a different extension id", async () => {
    const listener = await bootBackground();

    const response = await callListener(
      listener,
      { type: "refreshAccessToken", accountId: "acc-1" },
      { id: "some-other-extension-id" },
    );

    expect(response).toBeUndefined();
    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
  });

  it("rejects malformed envelopes even when sent from this extension", async () => {
    const listener = await bootBackground();

    const missingAccountId = await callListener(
      listener,
      { type: "refreshAccessToken" },
      { id: SELF_RUNTIME_ID },
    );
    const wrongType = await callListener(
      listener,
      { type: "somethingElse", accountId: "acc-1" },
      { id: SELF_RUNTIME_ID },
    );
    const notAnObject = await callListener(
      listener,
      "refreshAccessToken",
      { id: SELF_RUNTIME_ID },
    );
    const emptyReviewerFetch = await callListener(
      listener,
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-1",
        owner: "",
        repo: "shotloom",
        pullNumber: "42",
        accountId: null,
      },
      { id: SELF_RUNTIME_ID },
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

    const response = await callListener(
      listener,
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-1",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
      },
      { id: SELF_RUNTIME_ID },
    );

    expect(response).toEqual({ ok: true, summary });
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

    const response = await callListener(
      listener,
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-1",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
      },
      { id: SELF_RUNTIME_ID },
    );

    expect(response).toEqual({ ok: true, summary });
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1");
    expect(fetchPullReviewerSummaryMock).toHaveBeenCalledTimes(2);
    expect(fetchPullReviewerSummaryMock.mock.calls[1][0]).toMatchObject({
      githubToken: "ghu_new",
    });
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("refreshes on metadata batch 401 and retries with the updated token", async () => {
    const listener = await bootBackground();
    const metadata = [
      {
        number: "42",
        authorLogin: "octo-author",
        requestedUsers: [],
        requestedTeams: ["maintainers"],
      },
    ];
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
    fetchPullReviewerMetadataBatchMock
      .mockRejectedValueOnce({ status: 401 })
      .mockResolvedValueOnce(metadata);

    const response = await callListener(
      listener,
      {
        type: "fetchPullReviewerMetadataBatch",
        requestId: "req-batch-1",
        owner: "cinev",
        repo: "shotloom",
        accountId: "acc-1",
        targetPullNumbers: ["42"],
      },
      { id: SELF_RUNTIME_ID },
    );

    expect(response).toEqual({ ok: true, metadata });
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1");
    expect(fetchPullReviewerMetadataBatchMock).toHaveBeenCalledTimes(2);
    expect(fetchPullReviewerMetadataBatchMock.mock.calls[1][0]).toMatchObject({
      githubToken: "ghu_new",
      targetPullNumbers: ["42"],
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

    const response = await callListener(
      listener,
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-1",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
      },
      { id: SELF_RUNTIME_ID },
    );

    expect(response).toMatchObject({
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

    const response = await callListener(
      listener,
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-1",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
      },
      { id: SELF_RUNTIME_ID },
    );

    expect(response).toMatchObject({
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

    const response = await callListener(
      listener,
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-1",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
      },
      { id: SELF_RUNTIME_ID },
    );

    expect(response).toMatchObject({
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

    await flushMicrotasks();
    expect(capturedSignal).not.toBeNull();
    const signal = capturedSignal as AbortSignal | null;
    if (signal == null) {
      throw new Error("expected background fetch signal");
    }
    expect(signal.aborted).toBe(false);

    const cancelResult = await callListener(
      listener,
      {
        type: "cancelPullReviewerSummary",
        requestId: "req-cancel",
      },
      { id: SELF_RUNTIME_ID },
    );

    expect(cancelResult).toBeUndefined();
    expect(signal.aborted).toBe(true);
  });

  describe("prunes TTL-expired queued cancels", () => {
    const baseTime = 1_700_000_000_000;
    const pastTtl = baseTime + CANCELED_REQUEST_TTL_MS + 1_000;

    async function setupTtlScenario(): Promise<{
      listener: MessageListener;
      getCapturedSignal: () => AbortSignal;
    }> {
      vi.setSystemTime(new Date(baseTime));
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

      listener(
        { type: "cancelPullReviewerSummary", requestId: "req-stale" },
        { id: SELF_RUNTIME_ID },
        () => {},
      );

      return {
        listener,
        getCapturedSignal: () => {
          if (capturedSignal == null) {
            throw new Error("expected background fetch signal");
          }
          return capturedSignal;
        },
      };
    }

    function dispatchStaleFetch(listener: MessageListener): void {
      void listener(
        {
          type: "fetchPullReviewerSummary",
          requestId: "req-stale",
          owner: "cinev",
          repo: "shotloom",
          pullNumber: "42",
          accountId: "acc-1",
        },
        { id: SELF_RUNTIME_ID },
        () => {},
      );
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("prunes when a later cancel arrives past the TTL", async () => {
      const { listener, getCapturedSignal } = await setupTtlScenario();

      vi.setSystemTime(new Date(pastTtl));
      listener(
        { type: "cancelPullReviewerSummary", requestId: "req-other" },
        { id: SELF_RUNTIME_ID },
        () => {},
      );

      dispatchStaleFetch(listener);

      await flushMicrotasks();
      expect(getCapturedSignal().aborted).toBe(false);
    });

    it("prunes on fetch entry even without another cancel", async () => {
      const { listener, getCapturedSignal } = await setupTtlScenario();

      vi.setSystemTime(new Date(pastTtl));
      dispatchStaleFetch(listener);

      await flushMicrotasks();
      expect(getCapturedSignal().aborted).toBe(false);
    });
  });

  it("consumes a queued cancel when it arrives before the reviewer fetch message", async () => {
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

    const cancelResult = await callListener(
      listener,
      {
        type: "cancelPullReviewerSummary",
        requestId: "req-pre-cancel",
      },
      { id: SELF_RUNTIME_ID },
    );
    expect(cancelResult).toBeUndefined();

    void listener(
      {
        type: "fetchPullReviewerSummary",
        requestId: "req-pre-cancel",
        owner: "cinev",
        repo: "shotloom",
        pullNumber: "42",
        accountId: "acc-1",
      },
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    await flushMicrotasks();
    expect(capturedSignal).not.toBeNull();
    const signal = capturedSignal as AbortSignal | null;
    if (signal == null) {
      throw new Error("expected background fetch signal");
    }
    expect(signal.aborted).toBe(true);
  });
});

describe("background refreshAccountInstallations dispatch", () => {
  it("dispatches valid refresh-installations messages from this extension", async () => {
    const listener = await bootBackground();

    const response = await callListener(
      listener,
      { type: "refreshAccountInstallations", accountId: "acc-1" },
      { id: SELF_RUNTIME_ID },
    );

    expect(refreshAccountInstallationsMock).toHaveBeenCalledTimes(1);
    expect(refreshAccountInstallationsMock).toHaveBeenCalledWith("acc-1");
    expect(response).toEqual({ ok: true });
  });

  it("returns the failure outcome from the installation-refresh service", async () => {
    refreshAccountInstallationsMock.mockResolvedValueOnce({
      ok: false,
      reason: "failed",
    });
    const listener = await bootBackground();

    const response = await callListener(
      listener,
      { type: "refreshAccountInstallations", accountId: "acc-1" },
      { id: SELF_RUNTIME_ID },
    );

    expect(response).toEqual({ ok: false, reason: "failed" });
  });

  it("rejects refresh-installations messages from a foreign extension id", async () => {
    const listener = await bootBackground();

    const response = await callListener(
      listener,
      { type: "refreshAccountInstallations", accountId: "acc-1" },
      { id: "other-extension-id" },
    );

    expect(response).toBeUndefined();
    expect(refreshAccountInstallationsMock).not.toHaveBeenCalled();
  });

  it("ignores malformed refresh-installations messages", async () => {
    const listener = await bootBackground();

    const missingAccountId = await callListener(
      listener,
      { type: "refreshAccountInstallations" },
      { id: SELF_RUNTIME_ID },
    );
    const emptyAccountId = await callListener(
      listener,
      { type: "refreshAccountInstallations", accountId: "" },
      { id: SELF_RUNTIME_ID },
    );

    expect(missingAccountId).toBeUndefined();
    expect(emptyAccountId).toBeUndefined();
    expect(refreshAccountInstallationsMock).not.toHaveBeenCalled();
  });
});

describe("background proactive refresh wiring", () => {
  it("schedules the proactive refresh alarm on boot", async () => {
    await bootBackground();

    expect(alarmsCreateMock).toHaveBeenCalledWith(
      PROACTIVE_REFRESH_ALARM_NAME,
      { periodInMinutes: PROACTIVE_REFRESH_PERIOD_MINUTES },
    );
  });

  it("refreshes eligible accounts when the proactive alarm fires", async () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    listAccountsMock.mockResolvedValue([
      {
        id: "acc-due",
        login: "due",
        avatarUrl: null,
        token: "ghu",
        createdAt: 1,
        installations: [],
        installationsRefreshedAt: 1,
        invalidated: false,
        invalidatedReason: null,
        refreshToken: "ghr",
        expiresAt: now + PROACTIVE_REFRESH_THRESHOLD_MS - 1_000,
        refreshTokenExpiresAt: null,
      },
    ]);

    await bootBackground();
    if (capturedAlarmListener == null) {
      throw new Error("background did not register an alarms.onAlarm listener");
    }
    capturedAlarmListener({ name: PROACTIVE_REFRESH_ALARM_NAME });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-due");
    vi.useRealTimers();
  });

  it("ignores alarms that do not match the proactive refresh name", async () => {
    await bootBackground();
    if (capturedAlarmListener == null) {
      throw new Error("background did not register an alarms.onAlarm listener");
    }

    capturedAlarmListener({ name: "unrelated-alarm" });
    await flushMicrotasks();

    expect(listAccountsMock).not.toHaveBeenCalled();
    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
  });

  it("invalidates accounts whose refresh token has already expired", async () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    listAccountsMock.mockResolvedValue([
      {
        id: "acc-refresh-expired",
        login: "expired-user",
        avatarUrl: null,
        token: "ghu",
        createdAt: 1,
        installations: [],
        installationsRefreshedAt: 1,
        invalidated: false,
        invalidatedReason: null,
        refreshToken: "ghr",
        expiresAt: now + 60_000,
        refreshTokenExpiresAt: now - 1,
      },
    ]);

    await bootBackground();
    if (capturedAlarmListener == null) {
      throw new Error("background did not register an alarms.onAlarm listener");
    }
    capturedAlarmListener({ name: PROACTIVE_REFRESH_ALARM_NAME });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(markAccountInvalidatedMock).toHaveBeenCalledWith(
      "acc-refresh-expired",
      "expired",
    );
    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
