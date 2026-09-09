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
      connectInput({ newAccountId: "retained-id", login: "Octocat", now: 12 }),
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
