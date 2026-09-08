import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUIClient, requestCapability } from "../src/runtime/ui-client";
import { DEFAULT_PREFERENCES } from "../src/shared/preferences";
import { uiSnapshotSchema, type UISnapshot } from "../src/runtime/ui-contract";
import { event, deferred } from "./helpers/ui-bridge-harness";

function port() {
  const onMessage = event<(value: unknown) => void>();
  const onDisconnect = event<() => void>();
  return { onMessage, onDisconnect, name: "fixture", disconnect: vi.fn() };
}
function snapshot(revision = 0, epoch = "worker-1"): UISnapshot {
  return {
    epoch,
    revision,
    accountsRevision: "accounts",
    accounts: null,
    preferences: { ...DEFAULT_PREFERENCES, showReviewerName: revision > 0 },
  };
}
const clients: ReturnType<typeof createUIClient>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("browser", { runtime: { lastError: undefined } });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup(input: Parameters<typeof createUIClient>[0] = {}) {
  const a = port();
  const b = port();
  const connect = vi.fn().mockReturnValueOnce(a).mockReturnValue(b);
  const client = createUIClient({ connect, ...input });
  clients.push(client);
  return { a, b, connect, client };
}
const publish = (p: ReturnType<typeof port>, value: UISnapshot) =>
  p.onMessage.emit({ type: "snapshot", snapshot: value });

describe("UI client snapshot ordering and lifecycle", () => {
  it("keeps a newer notification when the initial snapshot arrives late", async () => {
    const { a, client } = setup();
    const listener = vi.fn();
    client.subscribe(listener);
    const reading = client.read();
    publish(a, snapshot(2));
    publish(a, snapshot(0));
    publish(a, snapshot(2));
    expect(await reading).toEqual(snapshot(2));
    expect(await client.read()).toEqual(snapshot(2));
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it("hydrates an update occurring during reconnect and ignores old connection callbacks", async () => {
    const { a, b, connect, client } = setup();
    client.subscribe(() => {});
    publish(a, snapshot(5));
    const oldCallback = [...a.onMessage.listeners][0]!;
    a.onDisconnect.emit();
    const reading = client.read();
    await vi.advanceTimersByTimeAsync(500);
    publish(b, snapshot(1, "worker-2"));
    oldCallback({ type: "snapshot", snapshot: snapshot(99) });
    expect(await reading).toEqual(snapshot(1, "worker-2"));
    expect(connect).toHaveBeenCalledTimes(2);
    expect(a.onMessage.listeners.size).toBe(0);
    expect(a.onDisconnect.listeners.size).toBe(0);
  });
  it("shares one port for multiple subscribers and cleans up after the last one", () => {
    const { a, connect, client } = setup();
    const callback = vi.fn();
    const one = client.subscribe(callback);
    const two = client.subscribe(callback);
    publish(a, snapshot());
    expect(callback).toHaveBeenCalledTimes(2);
    one();
    expect(a.disconnect).not.toHaveBeenCalled();
    two();
    expect(a.disconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(a.onMessage.listeners.size + a.onDisconnect.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not ping a healthy idle worker and cancels a pending reconnect on teardown", async () => {
    const { a, connect, client } = setup();
    const release = client.subscribe(() => {});
    publish(a, snapshot());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
    a.onDisconnect.emit();
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it("reports invalid/unavailable events and rejects pending readers on disposal", async () => {
    const { a, client } = setup();
    client.subscribe(() => {});
    const reading = client.read();
    const rejected = expect(reading).rejects.toThrow("ui_state_unavailable");
    a.onMessage.emit({
      type: "snapshot",
      snapshot: { ...snapshot(), token: "synthetic" },
    });
    await rejected;
    publish(a, snapshot());
    client.dispose();
    await expect(client.read()).rejects.toThrow("ui_client_disposed");
    expect(() => client.subscribe(() => {})).toThrow("ui_client_disposed");
  });
  it("reports a synchronous connection failure without leaving a ten-second reader", async () => {
    const { client } = setup({
      connect: () => {
        throw new Error("synthetic transport details");
      },
    });
    await expect(client.read()).rejects.toThrow("ui_state_unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out a missing snapshot and removes its ephemeral port", async () => {
    const { a, client } = setup();
    const reading = expect(client.read()).rejects.toThrow(
      "ui_state_unavailable",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await reading;
    expect(a.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns current preferences when a stale operation reply follows a newer event", async () => {
    const reply = deferred<UISnapshot>();
    const { a, client } = setup({
      request: vi.fn(() => reply.promise) as typeof requestCapability,
    });
    client.subscribe(() => {});
    publish(a, snapshot());
    const patch = client.patchPreferences({
      type: "patchPreferences",
      patch: { showStateBadge: false },
    });
    publish(a, snapshot(2));
    reply.resolve({
      ...snapshot(1),
      preferences: { ...DEFAULT_PREFERENCES, showStateBadge: false },
    });
    expect(await patch).toEqual(snapshot(2).preferences);
  });
  it("does not return an old worker's operation reply after reconnection", async () => {
    const reply = deferred<UISnapshot>();
    const { a, b, client } = setup({
      request: vi.fn(() => reply.promise) as typeof requestCapability,
    });
    client.subscribe(() => {});
    publish(a, snapshot());
    const patch = client.patchPreferences({
      type: "patchPreferences",
      patch: { showReviewerName: true },
    });
    a.onDisconnect.emit();
    await vi.advanceTimersByTimeAsync(500);
    publish(b, snapshot(0, "worker-2"));
    reply.resolve(snapshot(2));
    expect(await patch).toEqual(snapshot(0, "worker-2").preferences);
    expect((await client.read()).epoch).toBe("worker-2");
  });
  it("only forwards validated flow notifications to live flow subscribers", () => {
    const { a, client } = setup();
    const flow = vi.fn();
    const release = client.subscribeFlows(flow);
    a.onMessage.emit({
      type: "deviceFlow",
      attemptId: "attempt-1",
      progress: { phase: "denied" },
    });
    expect(flow).toHaveBeenCalledWith("attempt-1", { phase: "denied" });
    a.onMessage.emit({
      type: "deviceFlow",
      attemptId: "attempt-1",
      progress: { phase: "denied", accessToken: "synthetic" },
    });
    expect(flow).toHaveBeenCalledTimes(1);
    release();
  });
  it.each([
    undefined,
    { ok: true, data: { ...snapshot(), token: "synthetic" } },
    { ok: false, error: "raw secret prose" },
  ])(
    "rejects malformed capability response %# without returning raw fields",
    async (response) => {
      vi.stubGlobal("browser", {
        runtime: { sendMessage: vi.fn(async () => response) },
      });
      await expect(
        requestCapability({ type: "getUISnapshot" }, uiSnapshotSchema),
      ).rejects.toThrow("invalid_capability_response");
    },
  );
  it("preserves a stable capability failure code", async () => {
    vi.stubGlobal("browser", {
      runtime: {
        sendMessage: vi.fn(async () => ({ ok: false, error: "forbidden" })),
      },
    });
    await expect(
      requestCapability({ type: "getUISnapshot" }, uiSnapshotSchema),
    ).rejects.toThrow("forbidden");
  });
});
