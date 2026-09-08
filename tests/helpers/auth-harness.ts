import { vi } from "vitest";
import type { AccountConnectInput } from "../../src/storage/accounts";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function connectInput(
  overrides: Partial<AccountConnectInput> = {},
): AccountConnectInput {
  return {
    login: "octocat",
    avatarUrl: null,
    token: "fixture-access-0",
    refreshToken: "fixture-refresh-0",
    expiresAt: 1,
    refreshTokenExpiresAt: null,
    installations: [],
    newAccountId: "acc-1",
    now: 1,
    ...overrides,
  };
}

type Storage = Record<string, unknown>;
type Keys = string | string[] | Record<string, unknown> | undefined;
export function createStorageHarness(initial: Storage = {}) {
  let data: Storage = structuredClone(initial);
  let getBarrier:
    | {
        matches: (keys: Keys) => boolean;
        entered: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  let setBarrier:
    | {
        entered: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  const get = vi.fn(async (keys?: Keys): Promise<Storage> => {
    const selected =
      typeof keys === "string"
        ? [keys]
        : Array.isArray(keys)
          ? keys
          : Object.keys(data);
    const result = structuredClone(
      Object.fromEntries(
        selected.filter((key) => key in data).map((key) => [key, data[key]]),
      ),
    );
    if (getBarrier?.matches(keys)) {
      const barrier = getBarrier;
      getBarrier = undefined;
      barrier.entered.resolve();
      await barrier.release.promise;
    }
    return result;
  });
  const set = vi.fn(async (values: Storage) => {
    if (setBarrier) {
      const barrier = setBarrier;
      setBarrier = undefined;
      barrier.entered.resolve();
      await barrier.release.promise;
    }
    data = { ...data, ...structuredClone(values) };
  });
  const remove = vi.fn(async (keys: string | string[]) => {
    for (const key of typeof keys === "string" ? [keys] : keys)
      delete data[key];
  });
  return {
    local: { get, set, remove },
    snapshot: () => structuredClone(data),
    pauseGet(matches: (keys: Keys) => boolean = () => true) {
      const barrier = {
        matches,
        entered: deferred<void>(),
        release: deferred<void>(),
      };
      getBarrier = barrier;
      return barrier;
    },
    pauseSet() {
      const barrier = { entered: deferred<void>(), release: deferred<void>() };
      setBarrier = barrier;
      return barrier;
    },
  };
}

export type DeferredRequest = {
  kind: "refresh" | "api";
  path: string;
  credential: string;
  response: ReturnType<typeof deferred<Response>>;
};

// Record only fixture generation labels, never Authorization headers/bodies.
export function createHttpHarness() {
  const pending: DeferredRequest[] = [];
  const waiters: Array<(request: DeferredRequest) => void> = [];
  const requests: DeferredRequest[] = [];
  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const kind = path === "/login/oauth/access_token" ? "refresh" : "api";
    const credentialValue =
      kind === "refresh"
        ? new URLSearchParams(String(init?.body)).get("refresh_token")
        : new Headers(init?.headers)
            .get("Authorization")
            ?.replace(/^Bearer /, "");
    const credential =
      credentialValue == null
        ? "public"
        : (/^fixture-(?:access|refresh)-(.+)$/.exec(credentialValue)?.[1] ??
          "unrecognized");
    const request: DeferredRequest = {
      kind,
      path,
      credential,
      response: deferred<Response>(),
    };
    requests.push(request);
    const waiter = waiters.shift();
    if (waiter) waiter(request);
    else pending.push(request);
    return request.response.promise;
  });
  return {
    fetch,
    requests,
    next(): Promise<DeferredRequest> {
      const ready = pending.shift();
      return ready
        ? Promise.resolve(ready)
        : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
export const rotated = (generation = "1", omitRotation = false) =>
  json({
    access_token: `fixture-access-${generation}`,
    token_type: "bearer",
    expires_in: 28_800,
    ...(omitRotation
      ? {}
      : {
          refresh_token: `fixture-refresh-${generation}`,
          refresh_token_expires_in: 15_552_000,
        }),
  });

export async function bootAuthBackground(
  storage: ReturnType<typeof createStorageHarness>,
) {
  type Listener = (
    message: unknown,
    sender: { id?: string; url?: string },
    send: (value?: unknown) => void,
  ) => unknown;
  let listener!: Listener;
  const id = "auth-test-extension";
  const optionsUrl = `chrome-extension://${id}/options.html`;
  const sendMessage = vi.fn(
    (message: unknown): Promise<unknown> =>
      new Promise((resolve) => {
        const result = listener(message, { id, url: optionsUrl }, resolve);
        if (result !== true) resolve(result);
      }),
  );
  vi.stubGlobal("defineBackground", (main: () => void) => ({ main }));
  vi.stubGlobal("browser", {
    storage: { local: storage.local },
    runtime: {
      id,
      getURL: (path: string) => `chrome-extension://${id}${path}`,
      onMessage: {
        addListener: (value: Listener) => {
          listener = value;
        },
      },
      onInstalled: { addListener: vi.fn() },
      openOptionsPage: vi.fn(),
      sendMessage,
    },
    alarms: {
      get: vi.fn(),
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
    action: { onClicked: { addListener: vi.fn() } },
  });
  const { default: background } = await import("../../entrypoints/background");
  background.main!();
  return { sendMessage, listener, id, optionsUrl };
}
