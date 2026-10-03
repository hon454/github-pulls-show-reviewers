import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountMutations } from "../src/storage/accounts";
import { DEFAULT_PREFERENCES } from "../src/shared/preferences";
import { UI_STATE_CHANGED } from "../src/runtime/ui-contract";
import { connectInput, json } from "./helpers/auth-harness";
import {
  contentSender,
  optionsSender,
  createUIBridgeHarness,
  containsSecret,
  SENTINELS,
  drain,
} from "./helpers/ui-bridge-harness";

let harness: ReturnType<typeof createUIBridgeHarness>;
beforeEach(() => {
  harness = createUIBridgeHarness();
});
afterEach(async () => {
  harness.dispose();
  await drain();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const installation = {
  id: 1,
  account: { login: "octo", type: "Organization" as const, avatarUrl: null },
  repositorySelection: "all" as const,
  repoSnapshot: null,
};
async function add() {
  return accountMutations.upsertAccountByLogin(
    connectInput({
      token: SENTINELS.access,
      refreshToken: SENTINELS.refresh,
      installations: [installation],
    }),
  );
}

describe("real token-free background capability bridge", () => {
  it("restricts local/session storage before migration or any credential-bearing operation, and retries failed initialization", async () => {
    harness.browserMock.storage.local.setAccessLevel.mockRejectedValueOnce(
      new Error(SENTINELS.access),
    );
    expect(await harness.send({ type: "getUISnapshot" })).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(harness.storage.local.get).not.toHaveBeenCalled();
    expect(await harness.send({ type: "getUISnapshot" })).toMatchObject({
      ok: true,
      data: { preferences: DEFAULT_PREFERENCES },
    });
    expect(
      harness.browserMock.storage.local.setAccessLevel,
    ).toHaveBeenCalledTimes(2);
    expect(
      harness.browserMock.storage.session.setAccessLevel,
    ).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    await harness.restart();
    expect(
      harness.browserMock.storage.local.setAccessLevel,
    ).toHaveBeenCalledTimes(3);
  });

  it("returns projected summaries/snapshots and never delivers auth old/new records to either UI context", async () => {
    await add();
    const options = harness.client();
    const content = harness.client(contentSender());
    const stopA = options.subscribe(() => {});
    const stopB = content.subscribe(() => {});
    const a = await options.read();
    const b = await content.read();
    expect(a.accounts?.[0]).toMatchObject({
      id: "acc-1",
      login: "octocat",
      invalidated: false,
    });
    expect(b.accounts).toBeNull();
    const resolved = await harness.send(
      { type: "resolveAccount", owner: "octo", repo: "repo" },
      contentSender(),
    );
    expect(resolved).toMatchObject({ ok: true, data: { id: "acc-1" } });
    await accountMutations.commitAuth("acc-1", a.accounts![0].revision, {
      invalidatedReason: "revoked",
    });
    await harness.send({ type: "getUISnapshot" });
    expect(
      containsSecret([
        a,
        b,
        resolved,
        harness.replies,
        [...harness.notifications.values()],
      ]),
    ).toBe(false);
    // The sole raw storage listener belongs to background, regardless of clients.
    expect(harness.changes.listeners.size).toBe(1);
    stopA();
    stopB();
    options.dispose();
    content.dispose();
  });

  describe("announcing state changes to content documents without a port", () => {
    // A content document does not keep or re-establish a port while idle. The
    // announcement carries no state; the document reconnects and receives the
    // validated snapshot over its port.
    const announced = () =>
      harness.browserMock.tabs.sendMessage.mock.calls.filter(
        ([, message]) =>
          (message as { type?: string }).type === UI_STATE_CHANGED,
      );
    const openGitHubTabs = () =>
      harness.browserMock.tabs.query.mockResolvedValue([
        { id: 2 },
        { id: 3, discarded: true },
        {},
        { id: 5 },
      ]);

    it("announces a preference change to every live GitHub tab", async () => {
      openGitHubTabs();
      await harness.send({ type: "getUISnapshot" });
      expect(announced()).toEqual([]);

      await harness.send({
        type: "patchPreferences",
        patch: { showReviewerName: true },
      });
      await drain();

      expect(harness.browserMock.tabs.query).toHaveBeenCalledWith({
        url: "https://github.com/*",
      });
      expect(announced()).toEqual([
        [2, { type: UI_STATE_CHANGED }],
        [5, { type: UI_STATE_CHANGED }],
      ]);
    });

    it("announces an account change", async () => {
      openGitHubTabs();
      await harness.send({ type: "getUISnapshot" });

      await add();
      // Snapshot reads queue behind the refresh that the change started.
      await harness.send({ type: "getUISnapshot" });
      await drain();

      expect(announced().map(([tabId]) => tabId)).toEqual([2, 5]);
    });

    it("does not announce when only options-visible details change", async () => {
      openGitHubTabs();
      const account = await add();
      await harness.send({ type: "getUISnapshot" });
      await drain();
      harness.browserMock.tabs.sendMessage.mockClear();

      // Token rotation keeps the account's access identity.
      await accountMutations.commitAuth(
        account.id,
        (await harness.client().read()).accounts![0].revision,
        {
          tokens: {
            token: `${SENTINELS.access}-rotated`,
            refreshToken: SENTINELS.refresh,
            expiresAt: null,
            refreshTokenExpiresAt: null,
          },
        },
      );
      await harness.send({ type: "getUISnapshot" });
      await drain();

      expect(announced()).toEqual([]);
    });

    it("survives tabs that cannot be listed or reached", async () => {
      harness.browserMock.tabs.query.mockRejectedValue(new Error("no tabs"));
      await harness.send({ type: "getUISnapshot" });
      expect(
        await harness.send({
          type: "patchPreferences",
          patch: { showReviewerName: true },
        }),
      ).toMatchObject({ ok: true });
      await drain();

      openGitHubTabs();
      harness.browserMock.tabs.sendMessage.mockRejectedValue(
        new Error("Receiving end does not exist"),
      );
      expect(
        await harness.send({
          type: "patchPreferences",
          patch: { showReviewerName: false },
        }),
      ).toMatchObject({ ok: true });
      await drain();
    });
  });

  describe("content documents after a same-document navigation", () => {
    // Chrome keeps reporting the URL a document was loaded with in
    // `sender.url`; it does not follow history.pushState.
    const staleSender = () => ({
      ...contentSender(),
      url: "https://github.com/notifications",
    });
    const showTab = (url: string | undefined) =>
      harness.browserMock.tabs.get.mockResolvedValue({
        discarded: false,
        frozen: false,
        ...(url === undefined ? {} : { url }),
      } as never);
    const resolveOctoRepo = () =>
      harness.send(
        { type: "resolveAccount", owner: "octo", repo: "repo" },
        staleSender(),
      );

    it("authorizes a request for the repository the tab now shows", async () => {
      await add();
      showTab("https://github.com/octo/repo/pulls?q=is%3Aopen");

      expect(await resolveOctoRepo()).toMatchObject({
        ok: true,
        data: { id: "acc-1" },
      });
      expect(harness.browserMock.tabs.get).toHaveBeenCalledWith(2);
    });

    it("admits discovery and reviewer fetches for the repository the tab now shows", async () => {
      await add();
      showTab("https://github.com/octo/repo/pulls");

      const discovery = (await harness.send(
        {
          type: "beginRepositoryDiscovery",
          owner: "octo",
          repo: "repo",
          pageSession: "page-session",
          generation: 1,
        },
        staleSender(),
      )) as { ok: boolean; data: { id: string } };
      expect(discovery.ok).toBe(true);
      const reply = await harness.send(
        {
          type: "fetchPullReviewerMetadataBatch",
          requestId: "request-1",
          owner: "octo",
          repo: "repo",
          accountId: null,
          discoveryId: discovery.data.id,
          targetPullNumbers: [],
        },
        staleSender(),
      );
      expect(reply).not.toEqual({ ok: false, error: "forbidden" });
    });

    it.each([
      ["another repository", "https://github.com/octo/other/pulls"],
      ["a non-repository page", "https://github.com/notifications"],
      ["another origin", "https://evil.example/octo/repo/pulls"],
      ["an unreadable URL", undefined],
    ])("refuses when the tab shows %s", async (_label, tabUrl) => {
      await add();
      showTab(tabUrl);

      expect(await resolveOctoRepo()).toEqual({
        ok: false,
        error: "forbidden",
      });
    });

    it("refuses when the tab can no longer be read", async () => {
      await add();
      harness.browserMock.tabs.get.mockRejectedValue(new Error("No tab"));

      expect(await resolveOctoRepo()).toEqual({
        ok: false,
        error: "forbidden",
      });
    });

    it("does not read the tab when the load URL already names the repository", async () => {
      await add();
      harness.browserMock.tabs.get.mockClear();

      expect(
        await harness.send(
          { type: "resolveAccount", owner: "octo", repo: "repo" },
          contentSender(),
        ),
      ).toMatchObject({ ok: true });
      expect(harness.browserMock.tabs.get).not.toHaveBeenCalled();
    });
  });

  it.each([
    "startDeviceFlow",
    "pollDeviceFlow",
    "cancelDeviceFlow",
    "removeAccount",
    "patchPreferences",
    "diagnoseRepository",
  ])("rejects content capability %s", async (type) => {
    await add();
    const request =
      type === "removeAccount"
        ? { type, accountId: "acc-1" }
        : type === "patchPreferences"
          ? { type, patch: { language: "ko" } }
          : type === "diagnoseRepository"
            ? { type, owner: "octo", repo: "repo", mode: "matched" }
            : type === "pollDeviceFlow"
              ? { type, attemptId: "a", flowId: "f" }
              : { type, attemptId: "a" };
    expect(await harness.send(request, contentSender())).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect((await accountMutations.listAccounts()).length).toBe(1);
  });

  it.each([
    {},
    { id: "other", documentId: "options-1", url: optionsSender().url },
    { ...optionsSender(), documentId: undefined },
    { ...optionsSender(), url: "chrome-extension://other/options.html" },
    {
      ...optionsSender(),
      url: "chrome-extension://token-free-test-extension/options.html/child",
    },
    { ...optionsSender(), url: `${optionsSender().url}?other=1` },
    { ...optionsSender(), url: `${optionsSender().url}#other` },
    { ...contentSender(), frameId: 1 },
    { ...contentSender(), tab: undefined },
    { ...contentSender(), url: "https://evil.example/octo/repo" },
    { ...contentSender(), url: "invalid" },
  ])("rejects an unauthenticated/unrecognized sender %#", async (sender) => {
    expect(await harness.send({ type: "getUISnapshot" }, sender)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(harness.storage.local.get).not.toHaveBeenCalled();
  });

  it.each([
    { type: "upsertAccountByLogin", input: { token: SENTINELS.access } },
    { type: "refreshAccessToken", accountId: "acc-1", generation: "legacy" },
    { type: "invalidateAccessToken", accountId: "acc-1", generation: "legacy" },
    { type: "getUISnapshot", storageKey: "account:auth:acc-1" },
    { type: "resolveAccount", owner: "octo", repo: "../user" },
    {
      type: "resolveAccount",
      owner: "octo",
      repo: "repo",
      url: "https://evil.example",
    },
    { type: "startDeviceFlow", attemptId: "a", clientId: "arbitrary-client" },
    null,
  ])(
    "rejects removed/generic/malformed operation %# without reflecting secrets",
    async (request) => {
      const response = await harness.send(request);
      expect(response).toEqual({ ok: false, error: "invalid-request" });
      expect(containsSecret(response)).toBe(false);
    },
  );

  it("limits repository-linked self-healing by sender repository and installed owner", async () => {
    await add();
    const fetch = vi.fn(async () =>
      json({ total_count: 0, installations: [] }),
    );
    vi.stubGlobal("fetch", fetch);
    for (const request of [
      { type: "refreshAccountInstallations", accountId: "acc-1" },
      {
        type: "refreshAccountInstallations",
        accountId: "acc-1",
        repository: { owner: "other", repo: "repo" },
      },
      {
        type: "refreshAccountInstallations",
        accountId: "missing",
        repository: { owner: "octo", repo: "repo" },
      },
      { type: "resolveAccount", owner: "other", repo: "repo" },
      { type: "resolveFallbackAccount", owner: "octo", repo: "other" },
    ])
      expect(await harness.send(request, contentSender())).toEqual({
        ok: false,
        error: "forbidden",
      });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await harness.send(
        {
          type: "refreshAccountInstallations",
          accountId: "acc-1",
          repository: { owner: "octo", repo: "repo" },
        },
        contentSender(),
      ),
    ).toEqual({ ok: true, data: { ok: true } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      (await accountMutations.getAccountById("acc-1"))?.installations,
    ).toEqual([]);
    expect(containsSecret(harness.replies)).toBe(false);
  });

  it("runs authenticated diagnostics in background and strips error messages and nested raw evidence", async () => {
    await add();
    const fetch = vi.fn(async () =>
      json(
        {
          message: SENTINELS.access,
          headers: { authorization: SENTINELS.refresh },
        },
        500,
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const response = await harness.send({
      type: "diagnoseRepository",
      owner: "octo",
      repo: "repo",
      mode: "matched",
    });
    expect(response).toMatchObject({
      ok: true,
      data: {
        kind: "matched",
        account: { login: "octocat" },
        result: {
          ok: false,
          outcome: "unknown-error",
          failures: [{ kind: "http", httpStatus: 500 }],
        },
      },
    });
    expect(containsSecret(response)).toBe(false);
    expect(JSON.stringify(response)).not.toContain('"message"');
    const noToken = await harness.send({
      type: "diagnoseRepository",
      owner: "octo",
      repo: "repo",
      mode: "no-token",
    });
    expect(noToken).toMatchObject({
      ok: true,
      data: { kind: "no-token", result: { authMode: "no-token" } },
    });
    expect(
      new Headers(
        (fetch.mock.calls as unknown as [unknown, RequestInit][])[1][1].headers,
      ).has("Authorization"),
    ).toBe(false);
  });

  it("keeps reviewer successes/errors token-free using the actual API service and scopes cancellation by document", async () => {
    await add();
    const fetch = vi.fn(async () => {
      throw new TypeError(`${SENTINELS.access}/${SENTINELS.refresh}`);
    });
    vi.stubGlobal("fetch", fetch);
    const begin = async (generation: number) => {
      const response = (await harness.send(
        {
          type: "beginRepositoryDiscovery",
          owner: "octo",
          repo: "repo",
          pageSession: "bridge-test",
          generation,
        },
        contentSender(),
      )) as { ok: true; data: { id: string } };
      return response.data.id;
    };
    const request = {
      type: "fetchPullReviewerSummary",
      discoveryId: await begin(0),
      requestId: "same",
      owner: "octo",
      repo: "repo",
      pullNumber: "1",
      accountId: "acc-1",
    };
    const failed = await harness.send(request, contentSender());
    expect(failed).toMatchObject({
      ok: false,
      error: { kind: "unknown", status: null },
    });
    expect(containsSecret(failed)).toBe(false);
    expect(JSON.stringify(failed)).not.toContain('"message"');
    const summary = {
      number: 1,
      user: { login: "author", token: SENTINELS.access },
      requested_reviewers: [{ login: "alice", accessToken: SENTINELS.access }],
      requested_teams: [],
      refresh_token: SENTINELS.refresh,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        json(
          url.includes("/reviews") || url.includes("/events") ? [] : [summary],
        ),
      ),
    );
    const success = await harness.send(
      { ...request, discoveryId: await begin(1) },
      contentSender(),
    );
    expect(success).toMatchObject({
      ok: true,
      summary: { requestedUsers: [{ login: "alice" }] },
    });
    expect(containsSecret(success)).toBe(false);
  });
});
