import { webcrypto } from "node:crypto";
import { vi } from "vitest";
import type { z } from "zod";
import { createStorageHarness, deferred } from "./auth-harness";
import { createRefreshCoordinator } from "../../src/auth/refresh-coordinator";
import { createInstallationRefreshService } from "../../src/background/installation-refresh";
import { createReviewerFetchService } from "../../src/background/reviewer-fetch";
import { createUIBridge } from "../../src/background/ui-bridge";
import { createStoragePolicy } from "../../src/background/storage-policy";
import {
  createUIClient,
  type requestCapability,
} from "../../src/runtime/ui-client";
import {
  capabilityResponseSchema,
  UI_STATE_PORT,
  type UIRequest,
} from "../../src/runtime/ui-contract";
import type { UISender } from "../../src/background/ui-sender";

export function event<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    listeners,
    addListener: (listener: T) => {
      listeners.add(listener);
    },
    removeListener: (listener: T) => {
      listeners.delete(listener);
    },
    emit: (...args: Parameters<T>) => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}
export const EXTENSION_ID = "token-free-test-extension";
export const optionsSender = (documentId = "options-1"): UISender => ({
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/options.html`,
  documentId,
  tab: { id: 1 },
  frameId: 0,
});
export const contentSender = (
  documentId = "content-1",
  repository = "octo/repo",
): UISender => ({
  id: EXTENSION_ID,
  url: `https://github.com/${repository}/pulls`,
  documentId,
  tab: { id: 2 },
  frameId: 0,
});

export function createUIBridgeHarness(
  initial: Record<string, unknown> = {},
  nativeDiscoveryLiveness = false,
) {
  const storage = createStorageHarness(initial);
  const session = createStorageHarness();
  const changes =
    event<
      (
        changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
        area: string,
      ) => void
    >();
  const alive = new Set(["options-1", "options-2", "content-1", "content-2"]);
  const replies: unknown[] = [];
  const notifications = new Map<string, unknown[]>();
  const pairs = new Set<{ documentId: string; disconnect: () => void }>();
  const local = {
    ...storage.local,
    setAccessLevel: vi.fn(async () => {}),
    set: vi.fn(async (values: Record<string, unknown>) => {
      const previous = storage.snapshot();
      await storage.local.set(values);
      changes.emit(
        Object.fromEntries(
          Object.entries(values).map(([key, newValue]) => [
            key,
            { oldValue: previous[key], newValue },
          ]),
        ),
        "local",
      );
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const previous = storage.snapshot();
      await storage.local.remove(keys);
      changes.emit(
        Object.fromEntries(
          (typeof keys === "string" ? [keys] : keys).map((key) => [
            key,
            { oldValue: previous[key] },
          ]),
        ),
        "local",
      );
    }),
  };
  const browserMock = {
    storage: {
      local,
      session: { ...session.local, setAccessLevel: vi.fn(async () => {}) },
      onChanged: changes,
    },
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}${path}`,
      getContexts: vi.fn(async ({ documentIds }: { documentIds: string[] }) =>
        documentIds
          .filter((id) => alive.has(id))
          .map((documentId) => ({ documentId })),
      ),
      openOptionsPage: vi.fn(async () => {}),
      lastError: undefined,
      sendMessage: vi.fn((request: unknown) => send(request, optionsSender())),
      connect: () => connect(optionsSender()),
    },
    tabs: {
      get: vi.fn(async () => ({ discarded: false, frozen: false })),
      sendMessage: vi.fn(
        async (
          _id: number,
          _message: unknown,
          options: { documentId: string },
        ) => {
          if (!alive.has(options.documentId))
            throw new Error("Receiving end does not exist");
          return { alive: true };
        },
      ),
      onRemoved: event<(tabId: number) => void>(),
    },
    i18n: { getUILanguage: () => "en" },
  };
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("__GITHUB_APP_CLIENT_ID__", "test-client-id");
  vi.stubGlobal("__GITHUB_APP_SLUG__", "test-app");
  vi.stubGlobal("__GITHUB_APP_NAME__", "Test App");
  vi.stubGlobal("__PROD__", false);
  vi.stubGlobal("browser", browserMock);

  function makeBridge() {
    const coordinator = createRefreshCoordinator({
      getClientId: () => "test-client-id",
    });
    const ensureReady = createStoragePolicy();
    return createUIBridge({
      ensureReady,
      coordinator,
      ...(nativeDiscoveryLiveness
        ? {}
        : {
            isDiscoveryOwnerAlive: async (owner: { documentId: string }) =>
              alive.has(owner.documentId),
          }),
      installations: createInstallationRefreshService({
        refreshCoordinator: coordinator,
      }),
      reviewers: createReviewerFetchService({
        refreshCoordinator: coordinator,
      }),
    });
  }
  let bridge = makeBridge();
  async function send(request: unknown, sender: UISender = optionsSender()) {
    const result = await bridge.handle(structuredClone(request), sender);
    replies.push(structuredClone(result));
    return result;
  }
  function connect(sender: UISender) {
    type Port = ReturnType<typeof browser.runtime.connect>;
    const receive = event<(message: unknown) => void>();
    const closed = event<() => void>();
    const backgroundClosed = event<() => void>();
    let disconnected = false;
    const pair = {
      documentId: sender.documentId!,
      disconnect() {
        if (disconnected) return;
        disconnected = true;
        pairs.delete(pair);
        backgroundClosed.emit();
        closed.emit();
      },
    };
    pairs.add(pair);
    const recorded = notifications.get(sender.documentId!) ?? [];
    notifications.set(sender.documentId!, recorded);
    const incoming = {
      name: UI_STATE_PORT,
      sender,
      postMessage(message: unknown) {
        if (disconnected) throw new Error("port_disconnected");
        const value = structuredClone(message);
        recorded.push(value);
        receive.emit(value);
      },
      disconnect: pair.disconnect,
      onMessage: event<() => void>(),
      onDisconnect: backgroundClosed,
    } as unknown as Port;
    const outgoing = {
      name: UI_STATE_PORT,
      onMessage: receive,
      onDisconnect: closed,
      postMessage: vi.fn(),
      disconnect: pair.disconnect,
    } as unknown as Port;
    bridge.connect(incoming);
    return outgoing;
  }
  function client(sender = optionsSender()) {
    const request = (async <T extends z.ZodType>(
      message: UIRequest,
      schema: T,
    ) => {
      const parsed = capabilityResponseSchema(schema).parse(
        await send(message, sender),
      ) as { ok: true; data: z.output<T> } | { ok: false; error: string };
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.data;
    }) as typeof requestCapability;
    return createUIClient({ connect: () => connect(sender), request });
  }
  return {
    storage,
    session,
    browserMock,
    alive,
    changes,
    replies,
    notifications,
    send,
    client,
    async initialize() {
      await bridge.initialize();
    },
    async restart() {
      // Unit-level restored-service verification; actual worker termination is
      // separately covered by the packaged Chrome regression.
      bridge.dispose();
      for (const pair of [...pairs]) pair.disconnect();
      bridge = makeBridge();
      await bridge.initialize();
    },
    closeOwner(owner: string) {
      alive.delete(owner);
      for (const pair of [...pairs])
        if (pair.documentId === owner) pair.disconnect();
    },
    dispose() {
      bridge.dispose();
      for (const pair of [...pairs]) pair.disconnect();
    },
  };
}

export const SENTINELS = {
  access: "SYNTHETIC_ACCESS_SECRET_175",
  refresh: "SYNTHETIC_REFRESH_SECRET_175",
  device: "SYNTHETIC_DEVICE_SECRET_175",
};
export const secretFields = [
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "deviceCode",
  "device_code",
  "authorization",
  "headers",
  "oldValue",
  "newValue",
];
export function containsSecret(value: unknown): boolean {
  if (typeof value === "string")
    return Object.values(SENTINELS).some((sentinel) =>
      value.includes(sentinel),
    );
  if (Array.isArray(value)) return value.some(containsSecret);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) => secretFields.includes(key) || containsSecret(item),
  );
}
export async function drain() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
export { deferred };
