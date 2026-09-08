import type { MockInstance } from "vitest";
// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDeviceFlowController } from "../entrypoints/options/device-flow-controller";

vi.mock("../src/github/auth", () => ({
  DeviceFlowError: class DeviceFlowError extends Error {
    constructor(
      public readonly code: string,
      message?: string,
    ) {
      super(message ?? code);
    }
  },
  initiateDeviceFlow: vi.fn(),
  pollForAccessToken: vi.fn(),
  fetchAuthenticatedUser: vi.fn(),
  fetchUserInstallations: vi.fn(),
  fetchInstallationRepositories: vi.fn(),
}));

import { accountMutations } from "../src/storage/accounts";
import {
  createUIBridgeHarness,
  containsSecret,
  drain,
} from "./helpers/ui-bridge-harness";
import { disposeUIClient } from "../src/runtime/ui-client";
let harness: ReturnType<typeof createUIBridgeHarness>;
let upsertAccountByLoginMock: MockInstance<
  typeof accountMutations.upsertAccountByLogin
>;
let removeAccountMock: MockInstance<
  typeof accountMutations.removeAccount
>;

const auth = await import("../src/github/auth");

beforeEach(async () => {
  vi.useFakeTimers();
  harness = createUIBridgeHarness();
  await harness.initialize();
  upsertAccountByLoginMock = vi.spyOn(accountMutations, "upsertAccountByLogin");
  removeAccountMock = vi.spyOn(accountMutations, "removeAccount");
});

afterEach(async () => {
  cleanup();
  disposeUIClient();
  await drain();
  expect(
    containsSecret([harness.replies, [...harness.notifications.values()]]),
  ).toBe(false);
  harness.dispose();
  await drain();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useDeviceFlowController", () => {
  it("starts idle", () => {
    const { result } = renderHook(() =>
      useDeviceFlowController({
        onConnected: vi.fn(),
      }),
    );
    expect(result.current.state.phase).toBe("idle");
  });

  it("transitions to waiting and then connected on success", async () => {
    (
      auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete:
        "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    (
      auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      status: "pending",
    });
    (
      auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      status: "success",
      accessToken: "ghu_token",
      refreshToken: "ghr_token",
      expiresAt: 1_000_000,
      refreshTokenExpiresAt: 2_000_000,
    });
    (
      auth.fetchAuthenticatedUser as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      login: "hon454",
      avatarUrl: null,
    });
    (
      auth.fetchUserInstallations as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      items: [],
      truncated: false,
    });

    const onConnected = vi.fn();
    const { result } = renderHook(() =>
      useDeviceFlowController({ onConnected }),
    );

    await act(async () => {
      result.current.start();
    });
    expect(result.current.state.phase).toBe("waiting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(onConnected).toHaveBeenCalled();
    expect(result.current.state.phase).toBe("connected");

    expect(upsertAccountByLoginMock).toHaveBeenCalledTimes(1);
    expect(upsertAccountByLoginMock.mock.calls[0][0]).toMatchObject({
      login: "hon454",
      token: "ghu_token",
      refreshToken: "ghr_token",
      expiresAt: 1_000_000,
      refreshTokenExpiresAt: 2_000_000,
    });
  });

  it("bumps the interval on slow_down", async () => {
    (
      auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete:
        "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    (auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ status: "slow_down", interval: 10 })
      .mockResolvedValue({ status: "pending" });

    const { result } = renderHook(() =>
      useDeviceFlowController({ onConnected: vi.fn() }),
    );
    await act(async () => {
      result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.state.phase).toBe("waiting");
    expect(
      (result.current.state as { phase: "waiting"; interval: number }).interval,
    ).toBeGreaterThanOrEqual(10);
  });

  it("transitions to expired when the clock passes expires_at", async () => {
    (
      auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete:
        "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 1,
      interval: 5,
    });
    (
      auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      status: "pending",
    });
    const { result } = renderHook(() =>
      useDeviceFlowController({ onConnected: vi.fn() }),
    );
    await act(async () => {
      result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(result.current.state.phase).toBe("expired");
  });

  it("cancel returns to idle", async () => {
    (
      auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete:
        "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    (
      auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      status: "pending",
    });

    const { result } = renderHook(() =>
      useDeviceFlowController({ onConnected: vi.fn() }),
    );
    await act(async () => {
      result.current.start();
    });
    await act(async () => {
      result.current.cancel();
    });
    expect(result.current.state.phase).toBe("idle");
  });

  it("stays idle when canceled before the device code request resolves", async () => {
    let resolveInit:
      | ((value: {
          deviceCode: string;
          userCode: string;
          verificationUri: string;
          verificationUriComplete: string;
          expiresIn: number;
          interval: number;
        }) => void)
      | null = null;
    (
      auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInit = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useDeviceFlowController({ onConnected: vi.fn() }),
    );

    await act(async () => {
      result.current.start();
    });
    await act(async () => {
      result.current.cancel();
    });
    await act(async () => {
      resolveInit?.({
        deviceCode: "dc",
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
        verificationUriComplete:
          "https://github.com/login/device?user_code=ABCD-EFGH",
        expiresIn: 900,
        interval: 5,
      });
      await Promise.resolve();
    });

    expect(result.current.state.phase).toBe("idle");
  });

  it("does not connect after canceling during installation fetch", async () => {
    let resolveUser:
      | ((value: { login: string; avatarUrl: null }) => void)
      | null = null;
    (
      auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete:
        "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    (
      auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      status: "success",
      accessToken: "ghu_token",
      refreshToken: "ghr_token",
      expiresAt: 1_000_000,
      refreshTokenExpiresAt: 2_000_000,
    });
    (
      auth.fetchAuthenticatedUser as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUser = resolve;
        }),
    );
    (
      auth.fetchUserInstallations as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      items: [],
      truncated: false,
    });

    const onConnected = vi.fn();
    const { result } = renderHook(() =>
      useDeviceFlowController({ onConnected }),
    );

    await act(async () => {
      result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.state.phase).toBe("fetching_installations");

    await act(async () => {
      result.current.cancel();
    });
    await act(async () => {
      resolveUser?.({ login: "hon454", avatarUrl: null });
      await Promise.resolve();
    });

    expect(result.current.state.phase).toBe("idle");
    expect(onConnected).not.toHaveBeenCalled();
  });
});

describe("locale-independent authentication evidence", () => {
  it.each([
    "device_flow_disabled",
    "incorrect_client_credentials",
    "invalid_response",
  ] as const)(
    "preserves known initiation code %s without freezing raw error prose",
    async (code) => {
      vi.mocked(auth.initiateDeviceFlow).mockRejectedValueOnce(
        new auth.DeviceFlowError(
          code,
          "external text must not become UI state",
        ),
      );
      const { result } = renderHook(() =>
        useDeviceFlowController({ onConnected: vi.fn() }),
      );
      await act(async () => {
        result.current.start();
      });
      expect(result.current.state).toEqual({ phase: "fatal", code });
    },
  );
  it("stores a stable unknown code and ignores a rejected request after cancellation", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(auth.initiateDeviceFlow).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const { result } = renderHook(() =>
      useDeviceFlowController({ onConnected: vi.fn() }),
    );
    await act(async () => {
      result.current.start();
      await drain();
      await result.current.cancel();
      reject(new Error("private raw details"));
    });
    expect(result.current.state).toEqual({ phase: "idle" });
    vi.mocked(auth.initiateDeviceFlow).mockRejectedValueOnce(
      new Error("private raw details"),
    );
    await act(async () => {
      result.current.start();
    });
    expect(result.current.state).toEqual({
      phase: "fatal",
      code: "unknown_error",
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const attemptInit = (code: string) => ({
  deviceCode: code,
  userCode: `${code.toUpperCase()}-CODE`,
  verificationUri: "https://github.com/login/device",
  verificationUriComplete: `https://github.com/login/device?user_code=${code}`,
  expiresIn: 900,
  interval: 5,
});
const successfulPoll = {
  status: "success" as const,
  accessToken: "fake-access",
  refreshToken: "fake-refresh",
  expiresAt: 1_000_000,
  refreshTokenExpiresAt: 2_000_000,
};
const selectedInstallation = {
  id: 1,
  account: { login: "example", type: "Organization" as const, avatarUrl: null },
  repositorySelection: "selected" as const,
};

async function advancePoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
}

describe("attempt ownership with transports that ignore abort", () => {
  beforeEach(() => {
    vi.mocked(auth.initiateDeviceFlow)
      .mockReset()
      .mockResolvedValue(attemptInit("old"));
    vi.mocked(auth.pollForAccessToken)
      .mockReset()
      .mockResolvedValue(successfulPoll);
    vi.mocked(auth.fetchAuthenticatedUser)
      .mockReset()
      .mockResolvedValue({ login: "canceled-user", avatarUrl: null });
    vi.mocked(auth.fetchUserInstallations)
      .mockReset()
      .mockResolvedValue({ items: [selectedInstallation], truncated: false });
    vi.mocked(auth.fetchInstallationRepositories)
      .mockReset()
      .mockResolvedValue({ items: ["example/repo"], truncated: false });
  });

  const outcomes = [
    "success",
    "pending",
    "slow_down",
    "expired_token",
    "access_denied",
    "invalid_response",
    "rejection",
  ] as const;
  it.each(outcomes)(
    "ignores an old poll's %s after cancel and restart",
    async (outcome) => {
      const oldPoll =
        deferred<Awaited<ReturnType<typeof auth.pollForAccessToken>>>();
      vi.mocked(auth.pollForAccessToken)
        .mockImplementationOnce(() => oldPoll.promise)
        .mockResolvedValue({ status: "pending" });
      const onConnected = vi.fn();
      const { result } = renderHook(() =>
        useDeviceFlowController({ onConnected }),
      );
      await act(async () => {
        result.current.start();
      });
      await advancePoll();
      const oldSignal = vi.mocked(auth.pollForAccessToken).mock.calls[0][0]
        .signal!;
      vi.mocked(auth.initiateDeviceFlow).mockResolvedValue(attemptInit("new"));
      await act(async () => {
        result.current.cancel();
        result.current.start();
      });
      const waiting = result.current.state;
      expect(waiting).toMatchObject({
        phase: "waiting",
        userCode: "NEW-CODE",
        interval: 5,
      });
      await act(async () => {
        if (outcome === "success") oldPoll.resolve(successfulPoll);
        else if (outcome === "pending") oldPoll.resolve({ status: "pending" });
        else if (outcome === "slow_down")
          oldPoll.resolve({ status: "slow_down", interval: 60 });
        else
          oldPoll.reject(
            outcome === "rejection"
              ? new Error("private details")
              : new auth.DeviceFlowError(outcome),
          );
      });
      expect(upsertAccountByLoginMock).not.toHaveBeenCalled();
      expect(result.current.state).toEqual(waiting);
      expect(oldSignal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      expect(auth.fetchAuthenticatedUser).not.toHaveBeenCalled();
      expect(upsertAccountByLoginMock).not.toHaveBeenCalled();
      expect(onConnected).not.toHaveBeenCalled();
      await advancePoll();
      expect(
        vi
          .mocked(auth.pollForAccessToken)
          .mock.calls.map(([input]) => input.deviceCode),
      ).toEqual(["old", "new"]);
      expect(vi.getTimerCount()).toBe(1);
    },
  );

  for (const stage of [
    "initiation",
    "poll",
    "user",
    "installations",
    "repositories",
  ] as const) {
    for (const lifetime of [
      "cancel",
      "restart",
      "cancel-restart",
      "unmount",
    ] as const) {
      it.each(["resolve", "reject"] as const)(
        `ignores delayed ${stage} %s after ${lifetime}`,
        async (settlement) => {
          const pending = deferred<never>();
          const stageMock = {
            initiation: vi.mocked(auth.initiateDeviceFlow),
            poll: vi.mocked(auth.pollForAccessToken),
            user: vi.mocked(auth.fetchAuthenticatedUser),
            installations: vi.mocked(auth.fetchUserInstallations),
            repositories: vi.mocked(auth.fetchInstallationRepositories),
          }[stage];
          stageMock.mockImplementationOnce(() => pending.promise);
          const onConnected = vi.fn();
          const { result, unmount } = renderHook(() =>
            useDeviceFlowController({ onConnected }),
          );
          await act(async () => {
            result.current.start();
          });
          if (stage !== "initiation") await advancePoll();
          expect(stageMock).toHaveBeenCalledTimes(1);
          const oldSignal = stageMock.mock.calls[0][0].signal!;
          const priorCalls = [
            auth.fetchAuthenticatedUser,
            auth.fetchUserInstallations,
            auth.fetchInstallationRepositories,
          ].map((mock) => vi.mocked(mock).mock.calls.length);
          vi.mocked(auth.initiateDeviceFlow).mockResolvedValue(
            attemptInit("new"),
          );
          await act(async () => {
            if (lifetime === "unmount") unmount();
            else {
              if (lifetime !== "restart") result.current.cancel();
              if (lifetime !== "cancel") result.current.start();
            }
          });
          const current = result.current.state;
          expect(oldSignal.aborted).toBe(true);
          await act(async () => {
            if (settlement === "reject")
              pending.reject(new Error("late transport failure"));
            else
              pending.resolve(
                {
                  initiation: attemptInit("old"),
                  poll: successfulPoll,
                  user: { login: "canceled-user", avatarUrl: null },
                  installations: {
                    items: [selectedInstallation],
                    truncated: false,
                  },
                  repositories: { items: ["example/repo"], truncated: false },
                }[stage] as never,
              );
          });
          expect(result.current.state).toEqual(current);
          expect(vi.getTimerCount()).toBe(lifetime.includes("restart") ? 1 : 0);
          expect(
            [
              auth.fetchAuthenticatedUser,
              auth.fetchUserInstallations,
              auth.fetchInstallationRepositories,
            ].map((mock) => vi.mocked(mock).mock.calls.length),
          ).toEqual(priorCalls);
          expect(upsertAccountByLoginMock).not.toHaveBeenCalled();
          expect(onConnected).not.toHaveBeenCalled();
        },
      );
    }
  }

  it("clears a scheduled old timer when starting again and keeps the new deadline", async () => {
    vi.mocked(auth.initiateDeviceFlow)
      .mockResolvedValueOnce({ ...attemptInit("old"), expiresIn: 1 })
      .mockResolvedValue(attemptInit("new"));
    vi.mocked(auth.pollForAccessToken).mockResolvedValue({ status: "pending" });
    const { result } = renderHook(() =>
      useDeviceFlowController({ onConnected: vi.fn() }),
    );
    await act(async () => {
      result.current.start();
    });
    await act(async () => {
      result.current.start();
    });
    expect(vi.getTimerCount()).toBe(1);
    await advancePoll();
    expect(result.current.state).toMatchObject({
      phase: "waiting",
      userCode: "NEW-CODE",
    });
    expect(auth.pollForAccessToken).toHaveBeenCalledTimes(1);
    expect(vi.mocked(auth.pollForAccessToken).mock.calls[0][0].deviceCode).toBe(
      "new",
    );
  });

  it("keeps one sequence through slow-down, pending, and success", async () => {
    vi.mocked(auth.pollForAccessToken)
      .mockResolvedValueOnce({ status: "slow_down", interval: 0 })
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce(successfulPoll);
    const onConnected = vi.fn();
    const { result } = renderHook(() =>
      useDeviceFlowController({ onConnected }),
    );
    await act(async () => {
      result.current.start();
    });
    await advancePoll();
    expect(result.current.state).toMatchObject({
      phase: "waiting",
      interval: 10,
    });
    expect(vi.getTimerCount()).toBe(1);
    await advancePoll();
    expect(auth.pollForAccessToken).toHaveBeenCalledTimes(1);
    await advancePoll();
    expect(auth.pollForAccessToken).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(result.current.state.phase).toBe("connected");
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(upsertAccountByLoginMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "expired_token",
    "access_denied",
    "invalid_response",
    "unknown_error",
  ] as const)("retains current poll error mapping for %s", async (code) => {
    vi.mocked(auth.pollForAccessToken).mockRejectedValue(
      code === "unknown_error"
        ? new Error("private details")
        : new auth.DeviceFlowError(code),
    );
    const { result } = renderHook(() =>
      useDeviceFlowController({ onConnected: vi.fn() }),
    );
    await act(async () => {
      result.current.start();
    });
    await advancePoll();
    expect(result.current.state).toEqual(
      code === "expired_token"
        ? { phase: "expired" }
        : code === "access_denied"
          ? { phase: "denied" }
          : { phase: "fatal", code },
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const lifetime of ["cancel", "restart", "unmount"] as const) {
    it.each(["resolve", "reject"] as const)(
      `settles the real admitted commit via %s after ${lifetime} without rollback`,
      async (settlement) => {
        const write = harness.storage.pauseSet();
        const onConnected = vi.fn();
        const { result, unmount } = renderHook(() =>
          useDeviceFlowController({ onConnected }),
        );
        await act(async () => {
          result.current.start();
        });
        await advancePoll();
        await write.entered.promise;
        expect(upsertAccountByLoginMock).toHaveBeenCalledTimes(1);
        expect(result.current.state.phase).toBe("committing");
        vi.mocked(auth.initiateDeviceFlow).mockResolvedValue(
          attemptInit("new"),
        );
        let cancelled: boolean | undefined;
        await act(async () => {
          if (lifetime === "unmount") unmount();
          else if (lifetime === "restart") result.current.start();
          else cancelled = await result.current.cancel();
        });
        if (lifetime === "cancel") {
          expect(cancelled).toBe(false);
          expect(result.current.state.phase).toBe("committing");
        }
        await act(async () => {
          if (settlement === "reject")
            write.release.reject(new Error("synthetic write failure"));
          else write.release.resolve();
          await drain();
        });
        const accounts = await accountMutations.listAccounts();
        expect(accounts).toHaveLength(settlement === "resolve" ? 1 : 0);
        if (lifetime === "cancel") {
          expect(result.current.state.phase).toBe(
            settlement === "resolve" ? "connected" : "fatal",
          );
          expect(onConnected).toHaveBeenCalledTimes(
            settlement === "resolve" ? 1 : 0,
          );
          if (settlement === "resolve")
            expect(result.current.state).toEqual({
              phase: "connected",
              accountId: accounts[0]!.id,
            });
        } else {
          expect(onConnected).not.toHaveBeenCalled();
          if (lifetime === "restart")
            expect(result.current.state.phase).toBe("waiting");
        }
        expect(upsertAccountByLoginMock).toHaveBeenCalledTimes(1);
        expect(removeAccountMock).not.toHaveBeenCalled();
      },
    );
  }

  it("rechecks ownership after onConnected synchronously starts another attempt", async () => {
    const onConnected = vi.fn(() => {
      result.current.start();
    });
    const { result } = renderHook(() =>
      useDeviceFlowController({ onConnected }),
    );
    await act(async () => {
      result.current.start();
    });
    vi.mocked(auth.initiateDeviceFlow).mockResolvedValue(attemptInit("new"));
    await advancePoll();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({
      phase: "waiting",
      userCode: "NEW-CODE",
    });
    expect(vi.getTimerCount()).toBe(1);
  });
});
