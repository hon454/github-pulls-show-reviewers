// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account } from "../src/storage/accounts";
import type * as AccountsModule from "../src/storage/accounts";

type AccountsModuleType = typeof AccountsModule;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listAccountsMock = vi.fn<() => Promise<Account[]>>(async () => []);

vi.mock("../src/storage/accounts", async (importActual) => {
  const actual = await importActual<AccountsModuleType>();
  return {
    ...actual,
    listAccounts: listAccountsMock,
    addAccount: vi.fn(async () => {}),
    removeAccount: vi.fn(async () => {}),
    replaceInstallations: vi.fn(async () => {}),
    resolveAccountForRepo: vi.fn(async () => null),
  };
});

vi.mock("../src/github/auth", () => ({
  initiateDeviceFlow: vi.fn(),
  pollForAccessToken: vi.fn(),
  fetchAuthenticatedUser: vi.fn(),
  fetchUserInstallations: vi.fn(),
  fetchInstallationRepositories: vi.fn(),
  DeviceFlowError: class extends Error {},
}));

async function renderOptionsPage() {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  const [{ createRoot }, { OptionsPage }] = await Promise.all([
    import("react-dom/client"),
    import("../entrypoints/options/options-page"),
  ]);
  await act(async () => {
    createRoot(document.getElementById("root")!).render(
      createElement(OptionsPage),
    );
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderOptionsPageInStrictMode() {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  const [{ createRoot }, { StrictMode }, { OptionsPage }] = await Promise.all([
    import("react-dom/client"),
    import("react"),
    import("../entrypoints/options/options-page"),
  ]);
  await act(async () => {
    createRoot(document.getElementById("root")!).render(
      createElement(StrictMode, null, createElement(OptionsPage)),
    );
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  // `vi.mock` factory results are cached across `vi.resetModules()` in
  // this file (module cache is reset but factory outputs are reused), so
  // auth mock call history leaks between tests unless cleared here.
  vi.clearAllMocks();
  listAccountsMock.mockReset();
  listAccountsMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OptionsPage", () => {
  it("shows the empty accounts state when no accounts are stored", async () => {
    await renderOptionsPage();
    expect(
      document.querySelector('[data-testid="accounts-empty"]'),
    ).not.toBeNull();
  });

  it("shows the add-account start button", async () => {
    await renderOptionsPage();
    expect(
      document.querySelector('[data-testid="accounts-add"]'),
    ).not.toBeNull();
  });

  it("renders the diagnostics input and buttons", async () => {
    await renderOptionsPage();
    expect(
      document.querySelector('[data-testid="diagnostics-repo"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="diagnostics-matched"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="diagnostics-no-token"]'),
    ).not.toBeNull();
  });

  it("renders account cards when accounts are present", async () => {
    listAccountsMock.mockResolvedValue([
      {
        id: "acc",
        login: "hon454",
        avatarUrl: null,
        token: "ghu_abc",
        createdAt: 1,
        installations: [],
        installationsRefreshedAt: 1,
        invalidated: false,
        invalidatedReason: null,
      },
    ]);
    await renderOptionsPage();
    expect(
      document.querySelector('[data-testid="account-card-hon454"]'),
    ).not.toBeNull();
  });

  it("shows a configuration warning instead of blanking the page when production config is missing", async () => {
    vi.stubGlobal("__GITHUB_APP_CLIENT_ID__", "");
    vi.stubGlobal("__GITHUB_APP_SLUG__", "");
    vi.stubGlobal("__GITHUB_APP_NAME__", "");
    vi.stubGlobal("__PROD__", true);

    await renderOptionsPage();

    expect(
      document.querySelector('[data-testid="options-config-warning"]'),
    ).not.toBeNull();
  });

  it("auto-starts the device flow when the add-account panel opens", async () => {
    await renderOptionsPage();

    const auth = await import("../src/github/auth");
    const initiateDeviceFlow =
      auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>;
    initiateDeviceFlow.mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete:
        "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });

    const addButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="accounts-add"]',
    );
    expect(addButton).not.toBeNull();

    await act(async () => {
      addButton!.click();
      await Promise.resolve();
    });

    expect(initiateDeviceFlow).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid="add-account-start"]'),
    ).toBeNull();
  });

  it("closes the add-account panel when the user clicks Cancel during waiting", async () => {
    await renderOptionsPage();

    const auth = await import("../src/github/auth");
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
      status: "pending",
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="accounts-add"]')!
        .click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const userCode = document.querySelector('[data-testid="device-user-code"]');
    expect(userCode).not.toBeNull();
    expect(userCode!.textContent).toBe("ABCD-EFGH");

    const cancelButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.trim() === "Cancel");
    expect(cancelButton).toBeDefined();

    await act(async () => {
      cancelButton!.click();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="device-user-code"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="accounts-add"]'),
    ).not.toBeNull();
  });

  it("does not start the device flow twice under React StrictMode", async () => {
    await renderOptionsPageInStrictMode();

    const auth = await import("../src/github/auth");
    const initiateDeviceFlow =
      auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>;
    initiateDeviceFlow.mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete:
        "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });

    const addButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="accounts-add"]',
    );
    expect(addButton).not.toBeNull();

    await act(async () => {
      addButton!.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(initiateDeviceFlow).toHaveBeenCalledTimes(1);
  });
});
