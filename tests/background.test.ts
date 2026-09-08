import type { UISender } from "../src/background/ui-sender";
import type * as AccountsStorageModule from "../src/storage/accounts";
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
  invalidateAccountToken: markAccountInvalidatedMock,
  refreshAccountIfDue: refreshAccountTokenMock,
}));
createInstallationRefreshServiceMock.mockImplementation(() => ({
  refreshAccountInstallations: refreshAccountInstallationsMock,
}));

// These listener tests isolate API/coordinator dispatch. The production
// selection/ledger path is exercised with actual storage in repository-accounts
// and ui-bridge regression suites.
vi.mock("../src/background/account-resolution", () => ({
  createSelfHealingAccountResolver: () => ({
    resolveAccount: async () =>
      completeAccount(await getAccountByIdMock("acc-1")),
    resolveFallbackAccount: async () => null,
  }),
}));
function completeAccount(value: Record<string, unknown> | null | undefined) {
  if (!value) return null;
  return {
    login: "fixture-user",
    avatarUrl: null,
    createdAt: 1,
    invalidated: false,
    invalidatedReason: null,
    installationsRefreshedAt: 1,
    refreshToken: null,
    expiresAt: null,
    refreshTokenExpiresAt: null,
    installations: [
      {
        id: 1,
        account: { login: "cinev", type: "Organization", avatarUrl: null },
        repositorySelection: "all",
        repoSnapshot: null,
      },
    ],
    ...value,
  };
}
async function unauthorized() {
  const { GitHubApiError } = await import("../src/github/api");
  return new GitHubApiError(401, undefined, {
    name: "reviews",
    method: "GET",
    path: "/repos/cinev/shotloom/pulls/42/reviews",
  });
}

vi.mock("../src/auth/refresh-coordinator", () => ({
  createRefreshCoordinator: createRefreshCoordinatorMock,
}));

vi.mock("../src/background/installation-refresh", () => ({
  createInstallationRefreshService: createInstallationRefreshServiceMock,
}));

vi.mock("../src/config/github-app", () => ({
  getGitHubAppConfig: getGitHubAppConfigMock,
}));

vi.mock("../src/storage/accounts", async (importActual) => ({
  ...(await importActual<typeof AccountsStorageModule>()),
  accountMutations: {
    initialize: vi.fn(async () => {}),
    getAccountById: async (id: string) =>
      completeAccount(await getAccountByIdMock(id)),
    listAccounts: listAccountsMock,
  },
}));

vi.mock("../src/github/api", async () => {
  const actual =
    await vi.importActual<typeof GithubApiModule>("../src/github/api");
  return {
    ...actual,
    fetchPullReviewerSummary: fetchPullReviewerSummaryMock,
    fetchPullReviewerMetadataBatch: fetchPullReviewerMetadataBatchMock,
  };
});

type MessageSender = UISender;
type MessageListener = (
  message: unknown,
  sender: MessageSender | undefined,
  sendResponse: (value?: unknown) => void,
) => unknown;

const SELF_RUNTIME_ID = "self-extension-id";
const CONTENT_SENDER = {
  id: SELF_RUNTIME_ID,
  url: "https://github.com/cinev/shotloom/pulls",
  documentId: "content-doc",
  tab: { id: 1 },
  frameId: 0,
};
const OPTIONS_SENDER = {
  id: SELF_RUNTIME_ID,
  url: `chrome-extension://${SELF_RUNTIME_ID}/options.html`,
  documentId: "options-doc",
};

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
const openOptionsPageMock = vi.fn(async () => undefined);

beforeEach(() => {
  vi.resetModules();
  refreshAccountTokenMock.mockReset();
  fetchPullReviewerSummaryMock.mockReset();
  fetchPullReviewerMetadataBatchMock.mockReset().mockResolvedValue([]);
  getAccountByIdMock.mockReset();
  listAccountsMock.mockReset().mockResolvedValue([]);
  markAccountInvalidatedMock.mockReset();
  refreshAccountTokenMock.mockResolvedValue({
    ok: true,
    generation: "new-generation",
  });
  refreshAccountInstallationsMock.mockReset().mockResolvedValue({ ok: true });
  createRefreshCoordinatorMock.mockClear();
  createInstallationRefreshServiceMock.mockClear();
  getGitHubAppConfigMock.mockClear();
  alarmsCreateMock.mockClear();
  openOptionsPageMock.mockClear();
  capturedMessageListener = null;
  capturedAlarmListener = null;

  vi.stubGlobal("defineBackground", (main: () => void) => ({ main }));
  vi.stubGlobal("browser", {
    storage: {
      local: {
        setAccessLevel: vi.fn(async () => {}),
        get: vi.fn(async () => ({})),
      },
      session: {
        setAccessLevel: vi.fn(async () => {}),
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      id: SELF_RUNTIME_ID,
      getURL: (path: string) => `chrome-extension://${SELF_RUNTIME_ID}${path}`,
      onConnect: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((listener: MessageListener) => {
          capturedMessageListener = listener;
        }),
      },
      openOptionsPage: openOptionsPageMock,
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
  const listener = capturedMessageListener;
  const admission = (await callListener(
    listener,
    {
      type: "beginRepositoryDiscovery",
      pageSession: "listener-fixture",
      generation: 0,
      owner: "cinev",
      repo: "shotloom",
    },
    CONTENT_SENDER,
  )) as { ok: true; data: { id: string } };
  return (message, sender, send) => {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      ["fetchPullReviewerSummary", "fetchPullReviewerMetadataBatch"].includes(
        String(message.type),
      )
    ) {
      return listener(
        { ...message, discoveryId: admission.data.id },
        sender,
        send,
      );
    }
    return listener(message, sender, send);
  };
}

describe("background runtime.onMessage handler", () => {
  it("rejects the retired raw refresh capability even within this extension", async () => {
    const listener = await bootBackground();

    const response = await callListener(
      listener,
      { type: "refreshAccessToken", accountId: "acc-1", generation: "legacy" },
      CONTENT_SENDER,
    );

    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: false, error: "invalid-request" });
  });

  it("keeps the message channel open for async dispatch", async () => {
    const listener = await bootBackground();

    const sync = listener(
      { type: "refreshAccessToken", accountId: "acc-1", generation: "legacy" },
      CONTENT_SENDER,
      () => {},
    );

    expect(sync).toBe(true);
  });

  it("opens the options page for extension-originated banner CTA messages", async () => {
    const listener = await bootBackground();

    const response = await callListener(
      listener,
      { type: "openOptionsPage" },
      CONTENT_SENDER,
    );

    expect(openOptionsPageMock).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ ok: true });
  });

  it("reports a failed options page open back to the caller", async () => {
    openOptionsPageMock.mockRejectedValueOnce(new Error("blocked"));
    const listener = await bootBackground();

    const response = await callListener(
      listener,
      { type: "openOptionsPage" },
      CONTENT_SENDER,
    );

    expect(openOptionsPageMock).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ ok: false, error: "unavailable" });
  });

  it("rejects options page messages from a different extension id", async () => {
    const listener = await bootBackground();

    const response = await callListener(
      listener,
      { type: "openOptionsPage" },
      { id: "some-other-extension-id" },
    );

    expect(response).toBeUndefined();
    expect(openOptionsPageMock).not.toHaveBeenCalled();
  });

  it("rejects valid refresh messages from a different extension id", async () => {
    const listener = await bootBackground();

    const response = await callListener(
      listener,
      { type: "refreshAccessToken", accountId: "acc-1", generation: "legacy" },
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
      CONTENT_SENDER,
    );
    const wrongType = await callListener(
      listener,
      { type: "somethingElse", accountId: "acc-1" },
      CONTENT_SENDER,
    );
    const notAnObject = await callListener(
      listener,
      "refreshAccessToken",
      CONTENT_SENDER,
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
      CONTENT_SENDER,
    );

    expect(missingAccountId).toEqual({ ok: false, error: "invalid-request" });
    expect(wrongType).toEqual({ ok: false, error: "invalid-request" });
    expect(notAnObject).toEqual({ ok: false, error: "invalid-request" });
    expect(emptyReviewerFetch).toEqual({ ok: false, error: "invalid-request" });
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
      CONTENT_SENDER,
    );

    expect(response).toMatchObject({ ok: true, summary });
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
    getAccountByIdMock.mockResolvedValue({
      id: "acc-1",
      token: "ghu_old",
      refreshToken: "ghr_old",
    });
    refreshAccountTokenMock.mockImplementationOnce(async () => {
      getAccountByIdMock.mockResolvedValue({
        id: "acc-1",
        token: "ghu_new",
        refreshToken: "ghr_new",
      });
      return { ok: true, generation: "legacy" };
    });
    fetchPullReviewerSummaryMock
      .mockRejectedValueOnce(await unauthorized())
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
      CONTENT_SENDER,
    );

    expect(response).toMatchObject({ ok: true, summary });
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1", "legacy");
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
    getAccountByIdMock.mockResolvedValue({
      id: "acc-1",
      token: "ghu_old",
      refreshToken: "ghr_old",
    });
    refreshAccountTokenMock.mockImplementationOnce(async () => {
      getAccountByIdMock.mockResolvedValue({
        id: "acc-1",
        token: "ghu_new",
        refreshToken: "ghr_new",
      });
      return { ok: true, generation: "legacy" };
    });
    fetchPullReviewerMetadataBatchMock
      .mockRejectedValueOnce(await unauthorized())
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
      CONTENT_SENDER,
    );

    expect(response).toMatchObject({ ok: true, metadata });
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1", "legacy");
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
    refreshAccountTokenMock.mockResolvedValueOnce({
      ok: false,
      terminal: false,
    });
    fetchPullReviewerSummaryMock.mockRejectedValueOnce(await unauthorized());

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
      CONTENT_SENDER,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { kind: "github-api", status: 401 },
    });
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1", "legacy");
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("delegates a 401 without a refresh token to the coordinator", async () => {
    const listener = await bootBackground();
    getAccountByIdMock.mockResolvedValue({
      id: "acc-1",
      token: "ghu_old",
      refreshToken: null,
    });
    fetchPullReviewerSummaryMock.mockRejectedValueOnce(await unauthorized());
    refreshAccountTokenMock.mockResolvedValueOnce({
      ok: false,
      terminal: true,
    });

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
      CONTENT_SENDER,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { kind: "github-api", status: 401 },
    });
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1", "legacy");
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
  });

  it("marks the account revoked when the retry after refresh also returns 401", async () => {
    const listener = await bootBackground();
    getAccountByIdMock.mockResolvedValue({
      id: "acc-1",
      token: "ghu_old",
      refreshToken: "ghr_old",
    });
    refreshAccountTokenMock.mockImplementationOnce(async () => {
      getAccountByIdMock.mockResolvedValue({
        id: "acc-1",
        token: "ghu_new",
        refreshToken: "ghr_new",
      });
      return { ok: true, generation: "legacy" };
    });
    fetchPullReviewerSummaryMock
      .mockRejectedValueOnce(await unauthorized())
      .mockRejectedValueOnce(await unauthorized());

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
      CONTENT_SENDER,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { kind: "github-api", status: 401 },
    });
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1", "legacy");
    expect(markAccountInvalidatedMock).toHaveBeenCalledWith("acc-1", "legacy");
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
      CONTENT_SENDER,
      () => {},
    );

    await flushMicrotasks();
    await vi.waitFor(() => expect(capturedSignal).not.toBeNull());
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
      CONTENT_SENDER,
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

      await callListener(
        listener,
        { type: "cancelPullReviewerSummary", requestId: "req-stale" },
        CONTENT_SENDER,
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
        CONTENT_SENDER,
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
        CONTENT_SENDER,
        () => {},
      );

      dispatchStaleFetch(listener);

      await flushMicrotasks();
      await vi.waitFor(() => expect(getCapturedSignal().aborted).toBe(false));
    });

    it("prunes on fetch entry even without another cancel", async () => {
      const { listener, getCapturedSignal } = await setupTtlScenario();

      vi.setSystemTime(new Date(pastTtl));
      dispatchStaleFetch(listener);

      await flushMicrotasks();
      await vi.waitFor(() => expect(getCapturedSignal().aborted).toBe(false));
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
      CONTENT_SENDER,
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
      CONTENT_SENDER,
      () => {},
    );

    await flushMicrotasks();
    expect(capturedSignal).toBeNull();
    expect(fetchPullReviewerSummaryMock).not.toHaveBeenCalled();
    expect(fetchPullReviewerMetadataBatchMock).not.toHaveBeenCalled();
  });
});

describe("background refreshAccountInstallations dispatch", () => {
  it("dispatches valid refresh-installations messages from this extension", async () => {
    const listener = await bootBackground();

    const response = await callListener(
      listener,
      { type: "refreshAccountInstallations", accountId: "acc-1" },
      OPTIONS_SENDER,
    );

    expect(refreshAccountInstallationsMock).toHaveBeenCalledTimes(1);
    expect(refreshAccountInstallationsMock).toHaveBeenCalledWith("acc-1");
    expect(response).toEqual({ ok: true, data: { ok: true } });
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
      OPTIONS_SENDER,
    );

    expect(response).toEqual({
      ok: true,
      data: { ok: false, reason: "failed" },
    });
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
      OPTIONS_SENDER,
    );
    const emptyAccountId = await callListener(
      listener,
      { type: "refreshAccountInstallations", accountId: "" },
      OPTIONS_SENDER,
    );

    expect(missingAccountId).toEqual({ ok: false, error: "invalid-request" });
    expect(emptyAccountId).toEqual({ ok: false, error: "invalid-request" });
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

    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-due", now);
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

    expect(refreshAccountTokenMock).toHaveBeenCalledWith(
      "acc-refresh-expired",
      now,
    );
    expect(markAccountInvalidatedMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
