import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshAccountTokenMock = vi.fn();
const createRefreshCoordinatorMock = vi.fn(() => ({
  refreshAccountToken: refreshAccountTokenMock,
}));
const getGitHubAppConfigMock = vi.fn(() => ({ clientId: "test-client-id" }));

vi.mock("../src/auth/refresh-coordinator", () => ({
  createRefreshCoordinator: createRefreshCoordinatorMock,
}));

vi.mock("../src/config/github-app", () => ({
  getGitHubAppConfig: getGitHubAppConfigMock,
}));

type MessageSender = { id?: string };
type MessageListener = (
  message: unknown,
  sender: MessageSender | undefined,
  sendResponse: () => void,
) => unknown;

const SELF_RUNTIME_ID = "self-extension-id";

let capturedMessageListener: MessageListener | null;

beforeEach(() => {
  vi.resetModules();
  refreshAccountTokenMock.mockReset();
  refreshAccountTokenMock.mockResolvedValue({ ok: true, token: "new-token" });
  createRefreshCoordinatorMock.mockClear();
  getGitHubAppConfigMock.mockClear();
  capturedMessageListener = null;

  vi.stubGlobal("defineBackground", (main: () => void) => ({ main }));
  vi.stubGlobal("browser", {
    runtime: {
      id: SELF_RUNTIME_ID,
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((listener: MessageListener) => {
          capturedMessageListener = listener;
        }),
      },
      openOptionsPage: vi.fn(),
    },
    action: {
      onClicked: { addListener: vi.fn() },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function bootBackground(): Promise<MessageListener> {
  const { default: background } = await import("../entrypoints/background");
  background.main!();
  if (capturedMessageListener == null) {
    throw new Error("background did not register a runtime.onMessage listener");
  }
  return capturedMessageListener;
}

describe("background runtime.onMessage handler", () => {
  it("dispatches valid refresh messages that originate from this extension", async () => {
    const listener = await bootBackground();

    const result = listener(
      { type: "refreshAccessToken", accountId: "acc-1" },
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    expect(refreshAccountTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshAccountTokenMock).toHaveBeenCalledWith("acc-1");
    await expect(result as Promise<unknown>).resolves.toEqual({
      ok: true,
      token: "new-token",
    });
  });

  it("rejects valid refresh messages from a different extension id", async () => {
    const listener = await bootBackground();

    const result = listener(
      { type: "refreshAccessToken", accountId: "acc-1" },
      { id: "some-other-extension-id" },
      () => {},
    );

    expect(result).toBeUndefined();
    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
  });

  it("rejects malformed envelopes even when sent from this extension", async () => {
    const listener = await bootBackground();

    const missingAccountId = listener(
      { type: "refreshAccessToken" },
      { id: SELF_RUNTIME_ID },
      () => {},
    );
    const wrongType = listener(
      { type: "somethingElse", accountId: "acc-1" },
      { id: SELF_RUNTIME_ID },
      () => {},
    );
    const notAnObject = listener(
      "refreshAccessToken",
      { id: SELF_RUNTIME_ID },
      () => {},
    );

    expect(missingAccountId).toBeUndefined();
    expect(wrongType).toBeUndefined();
    expect(notAnObject).toBeUndefined();
    expect(refreshAccountTokenMock).not.toHaveBeenCalled();
  });
});
