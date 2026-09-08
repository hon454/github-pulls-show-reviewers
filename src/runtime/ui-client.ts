import type { z } from "zod";
import {
  UI_STATE_PORT,
  capabilityResponseSchema,
  uiStateEventSchema,
  uiSnapshotSchema,
  type UIRequest,
  type UISnapshot,
  type DeviceFlowProgress,
} from "./ui-contract";

type Port = ReturnType<typeof browser.runtime.connect>;
export type UIChange = {
  snapshot: UISnapshot;
  previous: UISnapshot | undefined;
};
export type UIClient = ReturnType<typeof createUIClient>;

export async function requestCapability<T extends z.ZodType>(
  request: UIRequest,
  schema: T,
): Promise<z.output<T>> {
  const raw: unknown = await browser.runtime.sendMessage(request);
  const parsed = capabilityResponseSchema(schema).safeParse(raw);
  if (!parsed.success) throw new Error("invalid_capability_response");
  const result = parsed.data as
    | { ok: true; data: z.output<T> }
    | { ok: false; error: string };
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** One client per document; no storage reads or raw storage event listeners. */
export function createUIClient(
  input: {
    connect?: () => Port;
    request?: typeof requestCapability;
  } = {},
) {
  const listeners = new Set<(change: UIChange) => void>();
  const flowListeners = new Set<
    (attemptId: string, progress: DeviceFlowProgress) => void
  >();
  const waiters = new Set<{
    resolve: (snapshot: UISnapshot) => void;
    reject: (error: Error) => void;
  }>();
  let current: UISnapshot | undefined;
  let port: Port | undefined;
  let disconnectPort: (() => void) | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connection = 0;
  let hydrated = false;
  let disposed = false;
  let unavailable = false;
  const request = input.request ?? requestCapability;

  function fail() {
    unavailable = true;
    hydrated = false;
    for (const waiter of waiters)
      waiter.reject(new Error("ui_state_unavailable"));
    waiters.clear();
  }

  function accept(snapshot: UISnapshot) {
    if (
      hydrated &&
      current?.epoch === snapshot.epoch &&
      current.revision >= snapshot.revision
    )
      return;
    const previous = current;
    unavailable = false;
    current = snapshot;
    hydrated = true;
    for (const waiter of waiters) waiter.resolve(snapshot);
    waiters.clear();
    for (const listener of listeners) listener({ snapshot, previous });
  }

  function connect() {
    if (disposed || port || listeners.size === 0) return;
    const ownConnection = ++connection;
    hydrated = false;
    unavailable = false;
    try {
      const next = (
        input.connect ??
        (() => browser.runtime.connect({ name: UI_STATE_PORT }))
      )();
      port = next;
      const onMessage = (message: unknown) => {
        if (ownConnection !== connection) return;
        const event = uiStateEventSchema.safeParse(message);
        if (!event.success || event.data.type === "unavailable") {
          fail();
          return;
        }
        if (event.data.type === "deviceFlow") {
          for (const listener of flowListeners)
            listener(event.data.attemptId, event.data.progress);
          return;
        }
        accept(event.data.snapshot);
      };
      const onDisconnect = () => {
        if (ownConnection !== connection) return;
        // Read lastError to consume Chrome's transport warning, never log it.
        void browser.runtime.lastError;
        disconnectPort?.();
        disconnectPort = undefined;
        port = undefined;
        hydrated = false;
        if (listeners.size && !disposed) {
          // Reconnect only after a real disconnect. No pings/keepalive traffic.
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            connect();
          }, 500);
        }
      };
      next.onMessage.addListener(onMessage);
      next.onDisconnect.addListener(onDisconnect);
      disconnectPort = () => {
        next.onMessage.removeListener(onMessage);
        next.onDisconnect.removeListener(onDisconnect);
      };
    } catch {
      fail();
      if (!reconnectTimer && listeners.size && !disposed)
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, 500);
    }
  }

  function stop() {
    connection += 1;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    disconnectPort?.();
    disconnectPort = undefined;
    const old = port;
    port = undefined;
    hydrated = false;
    old?.disconnect();
  }

  function subscribe(listener: (change: UIChange) => void) {
    if (disposed) throw new Error("ui_client_disposed");
    const notify = (change: UIChange) => listener(change);
    listeners.add(notify);
    connect();
    return () => {
      if (listeners.delete(notify) && listeners.size === 0) stop();
    };
  }

  async function read(): Promise<UISnapshot> {
    if (disposed) throw new Error("ui_client_disposed");
    const release = subscribe(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let waiter:
      | {
          resolve: (snapshot: UISnapshot) => void;
          reject: (error: Error) => void;
        }
      | undefined;
    try {
      if (hydrated && current) return current;
      if (unavailable) throw new Error("ui_state_unavailable");
      return await new Promise<UISnapshot>((resolve, reject) => {
        waiter = { resolve, reject };
        waiters.add(waiter);
        timeout = setTimeout(
          () => reject(new Error("ui_state_unavailable")),
          10_000,
        );
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      if (waiter) waiters.delete(waiter);
      release();
    }
  }

  return {
    read,
    subscribe,
    subscribeFlows(
      listener: (attemptId: string, progress: DeviceFlowProgress) => void,
    ) {
      flowListeners.add(listener);
      const release = subscribe(() => undefined);
      return () => {
        flowListeners.delete(listener);
        release();
      };
    },
    async patchPreferences(patch: UIRequest & { type: "patchPreferences" }) {
      const requestedConnection = connection;
      const snapshot = await request(patch, uiSnapshotSchema);
      // Operation replies share the same revision ordering as port events.
      if (
        !disposed &&
        hydrated &&
        requestedConnection === connection &&
        port &&
        current?.epoch === snapshot.epoch
      )
        accept(snapshot);
      if (!disposed && requestedConnection !== connection)
        return (await read()).preferences;
      if (
        hydrated &&
        current?.epoch === snapshot.epoch &&
        current.revision >= snapshot.revision
      )
        return current.preferences;
      return snapshot.preferences;
    },
    dispose() {
      disposed = true;
      stop();
      fail();
      listeners.clear();
      flowListeners.clear();
    },
  };
}

let client: UIClient | undefined;
export function getUIClient(): UIClient {
  return (client ??= createUIClient());
}
export function disposeUIClient(): void {
  client?.dispose();
  client = undefined;
}
