import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRefreshCoordinator } from "../src/auth/refresh-coordinator";
import {
  retryWithAccountRefresh,
  validateRepositoryAccessWithAccount,
} from "../src/auth/account-token-refresh";
import { createReviewerFetchService } from "../src/background/reviewer-fetch";
import { createInstallationRefreshService } from "../src/background/installation-refresh";
import { createProactiveRefreshService } from "../src/background/proactive-refresh";
import {
  PROACTIVE_REFRESH_ALARM_NAME,
  PROACTIVE_REFRESH_THRESHOLD_MS,
} from "../src/config/proactive-refresh";
import {
  accountMutations,
  credentialGeneration,
  getAccountById,
} from "../src/storage/accounts";
import {
  bootAuthBackground,
  connectInput,
  createHttpHarness,
  createStorageHarness,
  json,
  rotated,
} from "./helpers/auth-harness";

let storage: ReturnType<typeof createStorageHarness>;
let http: ReturnType<typeof createHttpHarness>;
let coordinator: ReturnType<typeof createRefreshCoordinator>;
const message = (requestId: string) => ({
  type: "fetchPullReviewerSummary" as const,
  requestId,
  owner: "octo",
  repo: "repo",
  pullNumber: "1",
  accountId: "acc-1",
  pullMetadata: {
    number: "1",
    authorLogin: "author",
    requestedUsers: [],
    requestedTeams: [],
  },
});
beforeEach(() => {
  storage = createStorageHarness();
  http = createHttpHarness();
  vi.stubGlobal("browser", { storage: { local: storage.local } });
  vi.stubGlobal("fetch", http.fetch);
  coordinator = createRefreshCoordinator({ getClientId: () => "test-client" });
});
afterEach(() => vi.unstubAllGlobals());

describe("deferred authenticated service schedules", () => {
  it("recovers an options snapshot read before missing-generation migration", async () => {
    await accountMutations.upsertAccountByLogin(connectInput());
    const key = "account:auth:acc-1";
    const auth = storage.snapshot()[key] as Record<string, unknown>;
    delete auth.credentialGeneration;
    await storage.local.set({ [key]: auth });
    const legacy = (await getAccountById("acc-1"))!;
    await bootAuthBackground(storage);
    await accountMutations.initialize();
    const work = validateRepositoryAccessWithAccount({
      account: legacy,
      repository: "octo/repo",
    });
    (await http.next()).response.resolve(json({}, 401));
    const recovery = await http.next();
    // Migration must not masquerade as a token rotation and consume the retry.
    const wasRefresh = recovery.kind === "refresh";
    recovery.response.resolve(wasRefresh ? rotated() : json({}, 401));
    if (wasRefresh) (await http.next()).response.resolve(json({}, 404));
    await work;
    expect(wasRefresh).toBe(true);
    expect((await getAccountById("acc-1"))?.invalidated).toBe(false);
  });

  it("A/B: a delayed g0 401 after A starts its g1 retry reuses g1, with exactly one refresh", async () => {
    await accountMutations.upsertAccountByLogin(connectInput());
    // Separate service instances still share the same background coordinator.
    const a = createReviewerFetchService({
      refreshCoordinator: coordinator,
    }).handleFetchMessage(message("A"));
    const b = createReviewerFetchService({
      refreshCoordinator: coordinator,
    }).handleFetchMessage(message("B"));
    const firstA = await http.next();
    const firstB = await http.next();
    expect([firstA.credential, firstB.credential]).toEqual(["0", "0"]);
    firstA.response.resolve(json({}, 401));
    const refresh = await http.next();
    expect(refresh.kind).toBe("refresh");
    refresh.response.resolve(rotated());
    const retryA = await http.next();
    expect(retryA.credential).toBe("1");
    // A's service has awaited the real coordinator's completed refresh promise.
    firstB.response.resolve(json({}, 401));
    const retryB = await http.next();
    expect({ kind: retryB.kind, credential: retryB.credential }).toEqual({
      kind: "api",
      credential: "1",
    });
    retryA.response.resolve(json([]));
    retryB.response.resolve(json([]));
    expect((await Promise.all([a, b])).map((result) => result.ok)).toEqual([
      true,
      true,
    ]);
    expect(http.requests.filter((r) => r.kind === "refresh").length).toBe(1);
    expect((await accountMutations.getAccountById("acc-1"))?.invalidated).toBe(
      false,
    );
  });

  it.each(["summary", "metadata"])(
    "an obsolete %s retry 401 cannot invalidate a newer rotation",
    async (kind) => {
      await accountMutations.upsertAccountByLogin(connectInput());
      const service = createReviewerFetchService({
        refreshCoordinator: coordinator,
      });
      const work =
        kind === "summary"
          ? service.handleFetchMessage(message("A"))
          : service.handleMetadataBatchMessage({
              type: "fetchPullReviewerMetadataBatch",
              requestId: "A",
              owner: "octo",
              repo: "repo",
              accountId: "acc-1",
            });
      (await http.next()).response.resolve(json({}, 401));
      (await http.next()).response.resolve(rotated());
      const retry = await http.next();
      const g1 = (await accountMutations.getAccountById("acc-1"))!;
      const anotherRefresh = coordinator.refreshAccountToken(
        g1.id,
        credentialGeneration(g1),
      );
      (await http.next()).response.resolve(rotated("2"));
      await anotherRefresh;
      retry.response.resolve(json({}, 401));
      expect((await work).ok).toBe(false);
      const current = await accountMutations.getAccountById("acc-1");
      expect(current?.token === "fixture-access-2").toBe(true);
      expect(current?.invalidated).toBe(false);
      expect(http.requests.filter((r) => r.kind === "api").length).toBe(2);
    },
  );

  it("a current retry's 401 still invalidates after one bounded recovery", async () => {
    await accountMutations.upsertAccountByLogin(connectInput());
    const work = createReviewerFetchService({
      refreshCoordinator: coordinator,
    }).handleFetchMessage(message("A"));
    (await http.next()).response.resolve(json({}, 401));
    (await http.next()).response.resolve(rotated());
    (await http.next()).response.resolve(json({}, 401));
    expect((await work).ok).toBe(false);
    expect(
      (await accountMutations.getAccountById("acc-1"))?.invalidatedReason,
    ).toBe("revoked");
    expect(http.requests.length).toBe(3);
  });

  it("a removed account is not retried with a refresh response token", async () => {
    await accountMutations.upsertAccountByLogin(connectInput());
    const work = createReviewerFetchService({
      refreshCoordinator: coordinator,
    }).handleFetchMessage(message("A"));
    (await http.next()).response.resolve(json({}, 401));
    const refresh = await http.next();
    await accountMutations.removeAccount("acc-1");
    refresh.response.resolve(rotated());
    expect((await work).ok).toBe(false);
    expect(http.requests.length).toBe(2);
    expect((await accountMutations.getAccountById("acc-1")) == null).toBe(true);
  });

  it("retains no-token public requests", async () => {
    const work = createReviewerFetchService({
      refreshCoordinator: coordinator,
    }).handleFetchMessage({ ...message("public"), accountId: null });
    const request = await http.next();
    expect(request.credential).toBe("public");
    request.response.resolve(json([]));
    expect((await work).ok).toBe(true);
    expect(http.requests.length).toBe(1);
  });

  it.each(["diagnostics", "generic"])(
    "%s stops if removal commits after successful recovery but before the retry read",
    async (kind) => {
      const background = await bootAuthBackground(storage);
      const old = await accountMutations.upsertAccountByLogin(connectInput());
      const send = background.sendMessage.getMockImplementation()!;
      background.sendMessage.mockImplementationOnce(async (message) => {
        const outcome = await send(message);
        await accountMutations.removeAccount(old.id);
        return outcome;
      });
      const work =
        kind === "diagnostics"
          ? validateRepositoryAccessWithAccount({
              account: old,
              repository: "octo/repo",
            }).then((r) => r.ok)
          : retryWithAccountRefresh({
              account: old,
              execute: async (token) => {
                const response = await fetch(
                  "https://api.github.com/user/installations",
                  {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                  },
                );
                if (!response.ok)
                  throw Object.assign(new Error("api_failure"), {
                    status: response.status,
                  });
                return true;
              },
            }).catch(() => false);
      (await http.next()).response.resolve(json({}, 401));
      (await http.next()).response.resolve(rotated());
      expect(await work).toBe(false);
      expect(http.requests.length).toBe(2);
      expect((await getAccountById(old.id)) == null).toBe(true);
    },
  );

  it("installation retries reuse a newer credential and cannot revoke a later sign-in", async () => {
    await accountMutations.upsertAccountByLogin(connectInput());
    const work = createInstallationRefreshService({
      refreshCoordinator: coordinator,
    }).refreshAccountInstallations("acc-1");
    const first = await http.next();
    const fresh = await accountMutations.upsertAccountByLogin(
      connectInput({ token: "fixture-access-login" }),
    );
    first.response.resolve(json({}, 401));
    const retry = await http.next();
    expect(retry.credential).toBe("login");
    const newest = await accountMutations.upsertAccountByLogin(
      connectInput({ token: "fixture-access-newest" }),
    );
    retry.response.resolve(json({}, 401));
    expect((await work).ok).toBe(false);
    expect(fresh.credentialGeneration === newest.credentialGeneration).toBe(
      false,
    );
    expect((await accountMutations.getAccountById("acc-1"))?.invalidated).toBe(
      false,
    );
    expect(http.requests.filter((r) => r.kind === "refresh").length).toBe(0);
  });

  it("an old successful installation snapshot cannot overwrite sign-in installations", async () => {
    await accountMutations.upsertAccountByLogin(connectInput());
    const work = createInstallationRefreshService({
      refreshCoordinator: coordinator,
    }).refreshAccountInstallations("acc-1");
    const request = await http.next();
    await accountMutations.upsertAccountByLogin(
      connectInput({
        installations: [
          {
            id: 99,
            account: { login: "new", type: "User", avatarUrl: null },
            repositorySelection: "all",
            repoSnapshot: null,
          },
        ],
      }),
    );
    request.response.resolve(json({ installations: [] }));
    await work;
    expect(
      (await accountMutations.getAccountById("acc-1"))?.installations.map(
        (i) => i.id,
      ),
    ).toEqual([99]);
  });

  it("options diagnostics use the runtime owner for stale failure and retry invalidation", async () => {
    const background = await bootAuthBackground(storage);
    const old = await accountMutations.upsertAccountByLogin(connectInput());
    const work = validateRepositoryAccessWithAccount({
      account: old,
      repository: "octo/repo",
    });
    const first = await http.next();
    await accountMutations.upsertAccountByLogin(
      connectInput({ token: "fixture-access-login" }),
    );
    first.response.resolve(json({}, 401));
    const retry = await http.next();
    expect(retry.credential).toBe("login");
    await accountMutations.upsertAccountByLogin(
      connectInput({ token: "fixture-access-newest" }),
    );
    retry.response.resolve(json({}, 401));
    expect((await work).outcome).toBe("token-invalid");
    expect((await accountMutations.getAccountById(old.id))?.invalidated).toBe(
      false,
    );
    expect(
      background.sendMessage.mock.calls.map(
        ([m]) => (m as { type: string }).type,
      ),
    ).toEqual(["refreshAccessToken", "invalidateAccessToken"]);
  });

  it("the generic options retry helper reuses current credentials through the runtime owner", async () => {
    await bootAuthBackground(storage);
    const old = await accountMutations.upsertAccountByLogin(
      connectInput({ refreshToken: null }),
    );
    const work = retryWithAccountRefresh({
      account: old,
      execute: async (token) => {
        const response = await fetch(
          "https://api.github.com/user/installations",
          { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        );
        if (!response.ok)
          throw Object.assign(new Error("api_failure"), {
            status: response.status,
          });
        return response.status;
      },
    });
    const first = await http.next();
    await accountMutations.upsertAccountByLogin(
      connectInput({ token: "fixture-access-login", refreshToken: null }),
    );
    first.response.resolve(json({}, 401));
    const retry = await http.next();
    expect(retry.credential).toBe("login");
    retry.response.resolve(json([]));
    expect(await work).toBe(200);
    expect(http.requests.length).toBe(2);
  });

  it.each(["expired", "due"])(
    "alarm rechecks a stale %s snapshot after sign-in",
    async (kind) => {
      const now = Date.now();
      const old = await accountMutations.upsertAccountByLogin(
        connectInput({
          refreshTokenExpiresAt: kind === "expired" ? now - 1 : null,
        }),
      );
      const service = createProactiveRefreshService({
        refreshCoordinator: coordinator,
        now: () => now,
        listAccounts: async () => [old],
      });
      const signedIn = await accountMutations.upsertAccountByLogin(
        connectInput({
          expiresAt: now + PROACTIVE_REFRESH_THRESHOLD_MS,
          refreshTokenExpiresAt: now + 10_000_000,
        }),
      );
      await service.handleAlarmFire(PROACTIVE_REFRESH_ALARM_NAME);
      const current = await accountMutations.getAccountById(old.id);
      expect(current?.credentialGeneration).toBe(signedIn.credentialGeneration);
      expect(current?.invalidated).toBe(false);
      expect(http.requests.length).toBe(0);
    },
  );

  it("alarm invalidates a genuinely expired refresh token through the coordinator", async () => {
    const now = Date.now();
    const old = await accountMutations.upsertAccountByLogin(
      connectInput({ refreshTokenExpiresAt: now }),
    );
    const service = createProactiveRefreshService({
      refreshCoordinator: coordinator,
      now: () => now,
      listAccounts: accountMutations.listAccounts,
    });
    await service.handleAlarmFire(PROACTIVE_REFRESH_ALARM_NAME);
    expect(
      (await accountMutations.getAccountById(old.id))?.invalidatedReason,
    ).toBe("expired");
    expect(http.requests.length).toBe(0);
  });

  it("a delayed API failure reuses a completed proactive rotation", async () => {
    await accountMutations.upsertAccountByLogin(connectInput());
    const reviewer = createReviewerFetchService({
      refreshCoordinator: coordinator,
    }).handleFetchMessage(message("A"));
    const initial = await http.next();
    const alarm = createProactiveRefreshService({
      refreshCoordinator: coordinator,
      now: () => Date.now(),
      listAccounts: accountMutations.listAccounts,
    }).handleAlarmFire(PROACTIVE_REFRESH_ALARM_NAME);
    (await http.next()).response.resolve(rotated());
    await alarm;
    initial.response.resolve(json({}, 401));
    const retry = await http.next();
    expect({ kind: retry.kind, credential: retry.credential }).toEqual({
      kind: "api",
      credential: "1",
    });
    retry.response.resolve(json([]));
    expect((await reviewer).ok).toBe(true);
    expect(http.requests.filter((r) => r.kind === "refresh").length).toBe(1);
  });
});
