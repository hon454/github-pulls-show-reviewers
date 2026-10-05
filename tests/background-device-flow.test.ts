import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountMutations } from "../src/storage/accounts";
import { createDeviceFlowService } from "../src/background/device-flow";
import {
  capabilityResponseSchema,
  deviceFlowProgressSchema,
  type DeviceFlowProgress,
  type UIRequest,
} from "../src/runtime/ui-contract";
import { connectInput, json } from "./helpers/auth-harness";
import { CREDENTIAL_REQUEST_TIMEOUT_MS } from "../src/shared/credential-deadline";
import {
  createUIBridgeHarness,
  containsSecret,
  SENTINELS,
  optionsSender,
  deferred,
  drain,
} from "./helpers/ui-bridge-harness";

const baseTime = 1_800_000_000_000;
const SESSION_KEY = "background:device-flows:v1";
let harness: ReturnType<typeof createUIBridgeHarness>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(baseTime);
  harness = createUIBridgeHarness();
  fetchMock = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/login/device/code") return initiation();
    if (path === "/login/oauth/access_token") return tokens();
    if (path === "/user")
      return json({
        id: 1,
        login: "octocat",
        avatar_url: null,
        token: SENTINELS.access,
      });
    if (path === "/user/installations")
      return json({
        total_count: 0,
        installations: [],
        refresh_token: SENTINELS.refresh,
      });
    throw new Error("unexpected_fixture_endpoint");
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  harness.dispose();
  await drain();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const initiation = (extra: Record<string, unknown> = {}) =>
  json({
    device_code: SENTINELS.device,
    user_code: "ABCD-EFGH",
    verification_uri: "https://github.com/login/device",
    interval: 5,
    expires_in: 900,
    ...extra,
  });
const tokens = () =>
  json({
    access_token: SENTINELS.access,
    refresh_token: SENTINELS.refresh,
    token_type: "bearer",
    expires_in: 28_800,
    refresh_token_expires_in: 1_000_000,
  });
async function call(
  request: UIRequest,
  owner = "options-1",
): Promise<DeviceFlowProgress> {
  const result = capabilityResponseSchema(deviceFlowProgressSchema).parse(
    await harness.send(request, optionsSender(owner)),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(containsSecret(result)).toBe(false);
  return result.data;
}
async function start(attemptId = "attempt-a", owner = "options-1") {
  const result = await call({ type: "startDeviceFlow", attemptId }, owner);
  if (result.phase !== "waiting")
    throw new Error(`expected waiting, received ${result.phase}`);
  return result;
}
function poll(flowId: string, attemptId = "attempt-a", owner = "options-1") {
  return call({ type: "pollDeviceFlow", flowId, attemptId }, owner);
}
const tick = (seconds: number) => vi.setSystemTime(Date.now() + seconds * 1000);

describe("background OAuth device-flow ownership, restoration and cancellation", () => {
  it("retires one document's flow and erases its codes without cancelling another document", async () => {
    const service = createDeviceFlowService({
      ensureReady: async () => {},
      getClientId: () => "test-client",
      isOwnerAlive: async () => true,
    });
    await service.start("retired-document", "retired-attempt");
    const retained = await service.start("live-document", "live-attempt");
    await service.retireOwner("retired-document");
    const records = harness.session.snapshot()[SESSION_KEY] as Array<
      Record<string, unknown>
    >;
    const retired = records.find(
      (record) => record.owner === "retired-document",
    );
    expect(retired).toMatchObject({ phase: "cancelled" });
    expect(retired).not.toHaveProperty("deviceCode");
    expect(retired).not.toHaveProperty("userCode");
    expect(
      records.find((record) => record.owner === "live-document"),
    ).toMatchObject({ phase: "waiting" });
    expect(await service.start("live-document", "live-attempt")).toEqual(
      retained,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["polling", "committing"])(
    "failed session persistence for %s returns restart-required and admits no untracked work",
    async (phase) => {
      const init = await start();
      const original =
        harness.browserMock.storage.session.set.getMockImplementation()!;
      let rejected = false;
      harness.browserMock.storage.session.set.mockImplementation(
        async (values) => {
          const records = values[SESSION_KEY] as Array<{ phase: string }>;
          if (!rejected && records.some((record) => record.phase === phase)) {
            rejected = true;
            throw new Error(SENTINELS.device);
          }
          await original(values);
        },
      );
      tick(5);
      expect(await poll(init.flowId)).toEqual({
        phase: "fatal",
        code: "restart_required",
      });
      expect(rejected).toBe(true);
      expect(harness.storage.local.set).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(phase === "polling" ? 1 : 4);
      expect(await poll(init.flowId)).toEqual({
        phase: "fatal",
        code: "restart_required",
      });
      await harness.restart();
      expect(await poll(init.flowId)).toEqual({
        phase: "fatal",
        code: "restart_required",
      });
    },
  );
  it("keeps every OAuth secret inside background and returns the actual persisted existing account ID", async () => {
    await accountMutations.upsertAccountByLogin(
      connectInput({
        userId: 1,
        newAccountId: "retained-id",
        login: "Octocat",
        now: 12,
      }),
    );
    const client = harness.client();
    client.subscribe(() => {});
    await client.read();
    const init = await start();
    expect(init).toMatchObject({ interval: 5, expiresAt: baseTime + 900_000 });
    expect(init.flowId).not.toBe(SENTINELS.device);
    expect(JSON.stringify(harness.session.snapshot())).toContain(
      SENTINELS.device,
    );
    tick(5);
    const complete = await poll(init.flowId);
    expect(complete).toMatchObject({
      phase: "connected",
      account: { id: "retained-id", login: "octocat" },
    });
    const accounts = await accountMutations.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: "retained-id",
      createdAt: 12,
      token: SENTINELS.access,
      refreshToken: SENTINELS.refresh,
      connectionAttemptId: init.flowId,
    });
    expect(JSON.stringify(harness.session.snapshot())).not.toContain(
      SENTINELS.device,
    );
    expect(
      containsSecret([complete, [...harness.notifications.values()]]),
    ).toBe(false);
    const writes = harness.storage.local.set.mock.calls.length;
    expect(await poll(init.flowId)).toEqual(complete);
    expect(harness.storage.local.set).toHaveBeenCalledTimes(writes);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    client.dispose();
  });

  it("persists minimum polling interval, slow-down and original deadline across a restored service", async () => {
    const init = await start();
    expect(await poll(init.flowId)).toMatchObject({
      phase: "waiting",
      nextPollAt: baseTime + 5000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(
      json({
        error: "slow_down",
        interval: 12,
        error_description: SENTINELS.device,
      }),
    );
    tick(5);
    const slow = await poll(init.flowId);
    expect(slow).toMatchObject({
      phase: "waiting",
      interval: 12,
      expiresAt: init.expiresAt,
      nextPollAt: baseTime + 17_000,
    });
    await harness.restart();
    tick(11);
    expect(await poll(init.flowId)).toMatchObject({
      phase: "waiting",
      interval: 12,
      expiresAt: init.expiresAt,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    tick(1);
    expect(await poll(init.flowId)).toMatchObject({ phase: "connected" });
  });

  it("deduplicates concurrent polls and repeated initiation without duplicate HTTP or commits", async () => {
    const init = await start();
    expect(await start()).toEqual(init);
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    tick(5);
    const a = poll(init.flowId);
    const b = poll(init.flowId);
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    pending.resolve(tokens());
    const [one, two] = await Promise.all([a, b]);
    expect(one).toEqual(two);
    expect((await accountMutations.listAccounts()).length).toBe(1);
    expect(harness.storage.local.set).toHaveBeenCalledTimes(1);
  });

  it("acknowledges cancellation before initiation admission and rejects late/replayed starts", async () => {
    expect(
      await call({ type: "cancelDeviceFlow", attemptId: "attempt-a" }),
    ).toEqual({ phase: "cancelled" });
    expect(
      await call({ type: "startDeviceFlow", attemptId: "attempt-a" }),
    ).toEqual({ phase: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
    await harness.restart();
    expect(
      await call({ type: "startDeviceFlow", attemptId: "attempt-a" }),
    ).toEqual({ phase: "cancelled" });
  });

  it.each(["initiation", "token", "user", "installations"])(
    "cancellation during deferred %s prevents every later commit, including after restart",
    async (stage) => {
      const pending = deferred<Response>();
      const heldPath = {
        initiation: "/login/device/code",
        token: "/login/oauth/access_token",
        user: "/user",
        installations: "/user/installations",
      }[stage]!;
      const normal = fetchMock.getMockImplementation()!;
      const entered = deferred<void>();
      fetchMock.mockImplementation((url, init) => {
        if (new URL(String(url)).pathname === heldPath) {
          entered.resolve();
          return pending.promise;
        }
        return normal(url, init);
      });
      let work: Promise<DeviceFlowProgress>;
      let flowId: string | undefined;
      if (stage === "initiation")
        work = call({ type: "startDeviceFlow", attemptId: "attempt-a" });
      else {
        flowId = (await start()).flowId;
        tick(5);
        work = poll(flowId);
      }
      await entered.promise;
      const cancellation = await call({
        type: "cancelDeviceFlow",
        attemptId: "attempt-a",
      });
      expect(cancellation).toEqual({ phase: "cancelled" });
      pending.resolve(
        stage === "initiation"
          ? initiation()
          : stage === "token"
            ? tokens()
            : stage === "user"
              ? json({ login: "octocat" })
              : json({ total_count: 0, installations: [] }),
      );
      expect(await work).toEqual({ phase: "cancelled" });
      expect(await accountMutations.listAccounts()).toEqual([]);
      expect(JSON.stringify(harness.session.snapshot())).not.toContain(
        SENTINELS.device,
      );
      await harness.restart();
      if (flowId) expect(await poll(flowId)).toEqual({ phase: "cancelled" });
    },
  );

  it("returns committing after final admission and notifies accounts only after the successful write", async () => {
    const client = harness.client();
    client.subscribe(() => {});
    await client.read();
    const init = await start();
    const barrier = harness.storage.pauseSet();
    tick(5);
    const work = poll(init.flowId);
    await barrier.entered.promise;
    const cancelled = await call({
      type: "cancelDeviceFlow",
      attemptId: "attempt-a",
    });
    expect(cancelled).toEqual({ phase: "committing" });
    expect(harness.storage.snapshot().settings).toBeUndefined();
    expect(
      harness.notifications
        .get("options-1")
        ?.some((event) => JSON.stringify(event).includes('"login":"octocat"')),
    ).toBe(false);
    barrier.release.resolve();
    const complete = await work;
    expect(complete.phase).toBe("connected");
    await harness.send({ type: "getUISnapshot" });
    expect(
      harness.notifications
        .get("options-1")
        ?.some((event) => JSON.stringify(event).includes('"login":"octocat"')),
    ).toBe(true);
    expect(
      await call({ type: "cancelDeviceFlow", attemptId: "attempt-a" }),
    ).toEqual(complete);
    expect(containsSecret([...harness.notifications.values()])).toBe(false);
    client.dispose();
  });

  it("a new attempt cancels earlier cancellable work while late responses cannot advance it", async () => {
    const held = deferred<Response>();
    fetchMock.mockReturnValueOnce(held.promise);
    const a = call({ type: "startDeviceFlow", attemptId: "attempt-a" });
    await drain();
    const b = await start("attempt-b");
    held.resolve(initiation());
    expect(await a).toEqual({ phase: "cancelled" });
    tick(5);
    expect(await poll(b.flowId, "attempt-b")).toMatchObject({
      phase: "connected",
    });
    expect((await accountMutations.listAccounts()).length).toBe(1);
  });

  it("binds polling to the initiating options document and rejects mismatched flow identifiers", async () => {
    const init = await start();
    tick(5);
    for (const [owner, flowId, attemptId] of [
      ["options-2", init.flowId, "attempt-a"],
      ["options-1", "foreign-flow", "attempt-a"],
      ["options-1", init.flowId, "other-attempt"],
    ]) {
      expect(
        await harness.send(
          { type: "pollDeviceFlow", flowId, attemptId },
          optionsSender(owner),
        ),
      ).toEqual({ ok: false, error: "forbidden" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a waiting flow on ordinary disconnect when Chrome lacks getContexts", async () => {
    Object.defineProperty(harness.browserMock.runtime, "getContexts", {
      value: undefined,
    });
    const client = harness.client();
    const stop = client.subscribe(() => {});
    await client.read();
    const init = await start();
    stop();
    client.dispose();
    await drain();
    await harness.restart();
    expect(await poll(init.flowId)).toEqual(init);
    tick(5);
    expect(await poll(init.flowId)).toMatchObject({ phase: "connected" });
    expect(await accountMutations.listAccounts()).toHaveLength(1);
  });

  it("expires an abandoned flow by its original deadline without another HTTP poll", async () => {
    const init = await start();
    tick(901);
    await harness.restart();
    expect(await poll(init.flowId)).toEqual({ phase: "expired" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(harness.session.snapshot())).not.toContain(
      SENTINELS.device,
    );
  });

  it("retire secrets for a lost owner and cannot commit a late discovery result", async () => {
    const init = await start();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    tick(5);
    const work = poll(init.flowId);
    await drain();
    harness.closeOwner("options-1");
    pending.resolve(tokens());
    expect(await work).toEqual({ phase: "fatal", code: "restart_required" });
    expect(await accountMutations.listAccounts()).toEqual([]);
    expect(JSON.stringify(harness.session.snapshot())).not.toContain(
      SENTINELS.device,
    );
  });

  it.each(["/login/oauth/access_token", "/user", "/user/installations"])(
    "ends a hung %s request in a token poll as a network error without replaying it",
    async (hungPath) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(baseTime);
      const init = await start();
      const answer = fetchMock.getMockImplementation()!;
      const signals: Array<AbortSignal | null | undefined> = [];
      fetchMock.mockImplementation((url, request) => {
        if (new URL(String(url)).pathname !== hungPath)
          return answer(url, request);
        signals.push(request?.signal);
        return new Promise<Response>(() => {});
      });
      tick(5);
      const work = poll(init.flowId);
      await vi.advanceTimersByTimeAsync(CREDENTIAL_REQUEST_TIMEOUT_MS - 1);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await work).toEqual({ phase: "fatal", code: "network_error" });
      expect(signals[0]?.aborted).toBe(true);
      expect(await accountMutations.listAccounts()).toEqual([]);
      const calls = fetchMock.mock.calls.length;
      tick(5);
      expect(await poll(init.flowId)).toEqual({
        phase: "fatal",
        code: "network_error",
      });
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      expect(JSON.stringify(harness.session.snapshot())).not.toContain(
        SENTINELS.device,
      );
    },
  );

  it("ends a hung device-code request as a network error", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(baseTime);
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
    const work = call({ type: "startDeviceFlow", attemptId: "attempt-a" });
    await vi.advanceTimersByTimeAsync(CREDENTIAL_REQUEST_TIMEOUT_MS);
    expect(await work).toEqual({ phase: "fatal", code: "network_error" });
  });

  it.each(["initiating", "polling", "committing"])(
    "an interrupted %s without a receipt requires fresh sign-in and never repeats HTTP",
    async (phase) => {
      const init = await start();
      const records = harness.session.snapshot()[SESSION_KEY] as Record<
        string,
        unknown
      >[];
      records[0].phase = phase;
      await harness.session.local.set({ [SESSION_KEY]: records });
      await harness.restart();
      expect(await poll(init.flowId)).toEqual({
        phase: "fatal",
        code: "restart_required",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(harness.session.snapshot())).not.toContain(
        SENTINELS.device,
      );
    },
  );

  it("a restored committing record uses the atomic account receipt and actual ID without another commit", async () => {
    const init = await start();
    await accountMutations.upsertAccountByLogin(
      connectInput({
        newAccountId: "actual-id",
        connectionAttemptId: init.flowId,
      }),
    );
    const records = harness.session.snapshot()[SESSION_KEY] as Record<
      string,
      unknown
    >[];
    records[0].phase = "committing";
    await harness.session.local.set({ [SESSION_KEY]: records });
    const writes = harness.storage.local.set.mock.calls.length;
    await harness.restart();
    expect(await poll(init.flowId)).toMatchObject({
      phase: "connected",
      account: { id: "actual-id" },
    });
    expect(harness.storage.local.set).toHaveBeenCalledTimes(writes);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("missing session state after browser restart returns restart-required, never a false completion", async () => {
    const init = await start();
    await harness.session.local.remove(SESSION_KEY);
    await harness.restart();
    expect(await poll(init.flowId)).toEqual({
      phase: "fatal",
      code: "restart_required",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "authorization_pending",
    "access_denied",
    "expired_token",
    "device_flow_disabled",
    "unsupported_grant_type",
    "incorrect_client_credentials",
    "incorrect_device_code",
    "unrecognized-secret",
  ])(
    "returns stable status/code for %s without exposing OAuth descriptions",
    async (error) => {
      const init = await start();
      fetchMock.mockResolvedValueOnce(
        json({ error, error_description: SENTINELS.access }),
      );
      tick(5);
      const result = await poll(init.flowId);
      const phase =
        error === "authorization_pending"
          ? "waiting"
          : error === "access_denied"
            ? "denied"
            : error === "expired_token"
              ? "expired"
              : "fatal";
      expect(result.phase).toBe(phase);
      expect(containsSecret(result)).toBe(false);
      if (phase !== "waiting")
        expect(JSON.stringify(harness.session.snapshot())).not.toContain(
          SENTINELS.device,
        );
    },
  );
});

describe("background device flow after the token exchange", () => {
  type Route = (
    url: string,
    init: RequestInit | undefined,
  ) => Promise<Response> | Response | undefined;
  // Route one endpoint; every other request keeps the default fixtures.
  function route(path: string, handler: Route) {
    const normal = fetchMock.getMockImplementation()!;
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === path) {
        calls.push(String(url));
        const response = await handler(String(url), init);
        if (response) return response;
      }
      return normal(url, init);
    });
    return calls;
  }
  const installation = (id: number) => ({
    id,
    account: { login: `org-${id}`, type: "Organization", avatar_url: null },
    repository_selection: "all",
  });
  async function connect() {
    const init = await start();
    tick(5);
    return poll(init.flowId);
  }

  it.each([
    ["a 502", () => json({ message: "bad gateway" }, 502)],
    ["a secondary rate limit", () => json({ message: "slow down" }, 403)],
    [
      "a network error",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])(
    "retries /user after %s and keeps the exchanged tokens",
    async (_name, failure) => {
      let failed = false;
      const calls = route("/user", () => {
        if (failed) return undefined;
        failed = true;
        return failure();
      });

      expect(await connect()).toMatchObject({
        phase: "connected",
        account: { login: "octocat" },
      });
      expect(calls).toHaveLength(2);
      expect(await accountMutations.listAccounts()).toEqual([
        expect.objectContaining({
          token: SENTINELS.access,
          refreshToken: SENTINELS.refresh,
        }),
      ]);
    },
  );

  it("ends the attempt after bounded /user retries and scrubs its secrets", async () => {
    const calls = route("/user", () => json({ message: "unavailable" }, 503));

    expect(await connect()).toEqual({ phase: "fatal", code: "unknown_error" });
    expect(calls).toHaveLength(3);
    expect(await accountMutations.listAccounts()).toEqual([]);
    expect(JSON.stringify(harness.session.snapshot())).not.toContain(
      SENTINELS.device,
    );
  });

  it("does not retry a rejected /user request", async () => {
    const calls = route("/user", () => json({ message: "bad token" }, 401));

    expect(await connect()).toEqual({ phase: "fatal", code: "unknown_error" });
    expect(calls).toHaveLength(1);
  });

  it("commits the account when installations fail and fills them through installation refresh", async () => {
    let failures = 0;
    const calls = route("/user/installations", () => {
      if (failures >= 3) {
        return json({ total_count: 1, installations: [installation(1)] });
      }
      failures += 1;
      return json({ message: "unavailable" }, 502);
    });

    const connected = await connect();

    expect(connected).toMatchObject({
      phase: "connected",
      account: { login: "octocat", installations: [] },
    });
    await vi.waitFor(async () =>
      expect((await accountMutations.listAccounts())[0]).toMatchObject({
        token: SENTINELS.access,
        installations: [expect.objectContaining({ id: 1 })],
      }),
    );
    expect(calls).toHaveLength(4);
  });

  it("keeps an existing account's installations when they cannot be reloaded at sign-in", async () => {
    const existing = await accountMutations.upsertAccountByLogin(
      connectInput({
        userId: 1,
        installations: [
          {
            id: 9,
            account: { login: "kept", type: "Organization", avatarUrl: null },
            repositorySelection: "all",
            repoSnapshot: null,
          },
        ],
        now: 7,
      }),
    );
    route("/user/installations", () => json({ message: "unavailable" }, 502));

    expect(await connect()).toMatchObject({ phase: "connected" });

    await drain();
    expect(await accountMutations.getAccountById(existing.id)).toMatchObject({
      token: SENTINELS.access,
      installations: [expect.objectContaining({ id: 9 })],
      installationsRefreshedAt: 7,
    });
  });

  it("signs in with a truncated installation list", async () => {
    let page = 0;
    route("/user/installations", () => {
      page += 1;
      return new Response(
        JSON.stringify({
          total_count: 10_000,
          installations: [installation(page)],
        }),
        {
          headers: {
            "Content-Type": "application/json",
            link: `<https://api.github.com/user/installations?per_page=100&page=${page + 1}>; rel="next"`,
          },
        },
      );
    });

    expect(await connect()).toMatchObject({ phase: "connected" });
    const [account] = await accountMutations.listAccounts();
    expect(account.installations.map((entry) => entry.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("cancellation between /user retries prevents the commit", async () => {
    const held = deferred<Response>();
    const retried = deferred<void>();
    let attempts = 0;
    route("/user", () => {
      attempts += 1;
      if (attempts === 1) return json({ message: "bad gateway" }, 502);
      retried.resolve();
      return held.promise;
    });
    const init = await start();
    tick(5);
    const work = poll(init.flowId);
    await retried.promise;

    expect(
      await call({ type: "cancelDeviceFlow", attemptId: "attempt-a" }),
    ).toEqual({ phase: "cancelled" });
    held.resolve(json({ id: 1, login: "octocat", avatar_url: null }));

    expect(await work).toEqual({ phase: "cancelled" });
    expect(await accountMutations.listAccounts()).toEqual([]);
  });
});
