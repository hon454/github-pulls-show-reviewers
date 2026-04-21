// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
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

vi.mock("../src/storage/accounts", () => ({
  addAccount: vi.fn().mockResolvedValue(undefined),
  replaceInstallations: vi.fn().mockResolvedValue(undefined),
}));

const auth = await import("../src/github/auth");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useDeviceFlowController", () => {
  it("starts idle", () => {
    const { result } = renderHook(() =>
      useDeviceFlowController({
        clientId: "Iv1.test",
        onConnected: vi.fn(),
      }),
    );
    expect(result.current.state.phase).toBe("idle");
  });

  it("transitions to waiting and then connected on success", async () => {
    (auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete:
        "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    (auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "pending",
    });
    (auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "success",
      accessToken: "ghu_token",
    });
    (auth.fetchAuthenticatedUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      login: "hon454",
      avatarUrl: null,
    });
    (auth.fetchUserInstallations as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const onConnected = vi.fn();
    const { result } = renderHook(() =>
      useDeviceFlowController({ clientId: "Iv1.test", onConnected }),
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
  });

  it("bumps the interval on slow_down", async () => {
    (auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    (auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ status: "slow_down", interval: 10 })
      .mockResolvedValue({ status: "pending" });

    const { result } = renderHook(() =>
      useDeviceFlowController({ clientId: "Iv1.test", onConnected: vi.fn() }),
    );
    await act(async () => {
      result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.state.phase).toBe("waiting");
    expect((result.current.state as { phase: "waiting"; interval: number }).interval).toBeGreaterThanOrEqual(10);
  });

  it("transitions to expired when the clock passes expires_at", async () => {
    (auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 1,
      interval: 5,
    });
    (auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "pending",
    });
    const { result } = renderHook(() =>
      useDeviceFlowController({ clientId: "Iv1.test", onConnected: vi.fn() }),
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
    (auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    (auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "pending",
    });

    const { result } = renderHook(() =>
      useDeviceFlowController({ clientId: "Iv1.test", onConnected: vi.fn() }),
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
    let resolveInit: ((value: {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      expiresIn: number;
      interval: number;
    }) => void) | null = null;
    (auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInit = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useDeviceFlowController({ clientId: "Iv1.test", onConnected: vi.fn() }),
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
    let resolveUser: ((value: { login: string; avatarUrl: null }) => void) | null =
      null;
    (auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete:
        "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    (auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "success",
      accessToken: "ghu_token",
    });
    (auth.fetchAuthenticatedUser as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUser = resolve;
        }),
    );
    (auth.fetchUserInstallations as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const onConnected = vi.fn();
    const { result } = renderHook(() =>
      useDeviceFlowController({ clientId: "Iv1.test", onConnected }),
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
