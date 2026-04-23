// @vitest-environment jsdom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account } from "../src/storage/accounts";
import type * as AccountsModule from "../src/storage/accounts";

type AccountsModuleType = typeof AccountsModule;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listAccountsMock = vi.fn<() => Promise<Account[]>>(async () => []);
const getAccountByIdMock = vi.fn<() => Promise<Account | null>>(async () => null);
const replaceInstallationsMock = vi.fn(async () => {});

const getPreferencesMock = vi.fn(async () => ({
  version: 1 as const,
  showStateBadge: true,
  showReviewerName: false,
}));
const updatePreferencesMock = vi.fn(async (patch: Record<string, unknown>) => ({
  version: 1 as const,
  showStateBadge: true,
  showReviewerName: false,
  ...patch,
}));

vi.mock("../src/storage/accounts", async (importActual) => {
  const actual = await importActual<AccountsModuleType>();
  return {
    ...actual,
    listAccounts: listAccountsMock,
    addAccount: vi.fn(async () => {}),
    removeAccount: vi.fn(async () => {}),
    replaceInstallations: replaceInstallationsMock,
    getAccountById: getAccountByIdMock,
    resolveAccountForRepo: vi.fn(async () => null),
  };
});

vi.mock("../src/storage/preferences", () => ({
  getPreferences: getPreferencesMock,
  updatePreferences: updatePreferencesMock,
  DEFAULT_PREFERENCES: {
    version: 1,
    showStateBadge: true,
    showReviewerName: false,
  },
  isPreferencesChange: () => false,
  isAccountsChange: () => false,
}));

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
  getAccountByIdMock.mockReset();
  replaceInstallationsMock.mockReset();
  listAccountsMock.mockResolvedValue([]);
  getAccountByIdMock.mockResolvedValue(null);
  getPreferencesMock.mockClear();
  updatePreferencesMock.mockClear();
  getPreferencesMock.mockResolvedValue({
    version: 1,
    showStateBadge: true,
    showReviewerName: false,
  });
  vi.stubGlobal("browser", {
    runtime: {
      sendMessage: vi.fn(),
    },
  });
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
        refreshToken: null,
        expiresAt: null,
        refreshTokenExpiresAt: null,
      },
    ]);
    await renderOptionsPage();
    expect(
      document.querySelector('[data-testid="account-card-hon454"]'),
    ).not.toBeNull();
  });

  it("refreshes installations after a 401 by requesting a new access token", async () => {
    const account: Account = {
      id: "acc",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_old",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
      refreshToken: "ghr_old",
      expiresAt: null,
      refreshTokenExpiresAt: null,
    };
    listAccountsMock.mockResolvedValue([account]);
    getAccountByIdMock.mockResolvedValue({
      ...account,
      token: "ghu_new",
      refreshToken: "ghr_new",
    });

    await renderOptionsPage();

    const auth = await import("../src/github/auth");
    const fetchUserInstallations =
      auth.fetchUserInstallations as unknown as ReturnType<typeof vi.fn>;
    const fetchInstallationRepositories =
      auth.fetchInstallationRepositories as unknown as ReturnType<typeof vi.fn>;

    fetchUserInstallations
      .mockRejectedValueOnce(new Error("GET /user/installations failed with status 401."))
      .mockResolvedValueOnce([
        {
          id: 42,
          account: { login: "cinev", type: "Organization", avatarUrl: null },
          repositorySelection: "selected",
        },
      ]);
    fetchInstallationRepositories.mockResolvedValueOnce(["cinev/shotloom"]);

    const sendMessageMock = vi.fn().mockResolvedValue({ ok: true, token: "ghu_new" });
    vi.stubGlobal("browser", {
      runtime: {
        sendMessage: sendMessageMock,
      },
    });

    const refreshButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Refresh installations");
    expect(refreshButton).toBeDefined();

    await act(async () => {
      refreshButton!.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: "refreshAccessToken",
      accountId: "acc",
    });
    expect(fetchUserInstallations).toHaveBeenCalledTimes(2);
    expect(fetchUserInstallations.mock.calls[1][0]).toMatchObject({
      token: "ghu_new",
    });
    expect(fetchInstallationRepositories).toHaveBeenCalledWith({
      token: "ghu_new",
      installationId: 42,
    });
    expect(replaceInstallationsMock).toHaveBeenCalledWith("acc", [
      {
        id: 42,
        account: { login: "cinev", type: "Organization", avatarUrl: null },
        repositorySelection: "selected",
        repoFullNames: ["cinev/shotloom"],
      },
    ]);
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

  it("restarts the device flow when reopening the add-account panel after a successful connection", async () => {
    await renderOptionsPage();

    const auth = await import("../src/github/auth");
    const initiateDeviceFlow =
      auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>;
    const pollForAccessToken =
      auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>;
    const fetchAuthenticatedUser =
      auth.fetchAuthenticatedUser as unknown as ReturnType<typeof vi.fn>;
    const fetchUserInstallations =
      auth.fetchUserInstallations as unknown as ReturnType<typeof vi.fn>;

    initiateDeviceFlow.mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete:
        "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 0,
    });
    pollForAccessToken.mockResolvedValue({
      status: "success",
      accessToken: "ghu_abc",
    });
    fetchAuthenticatedUser.mockResolvedValue({
      login: "hon454",
      avatarUrl: null,
    });
    fetchUserInstallations.mockResolvedValue([]);

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="accounts-add"]')!
        .click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(initiateDeviceFlow).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid="accounts-add"]'),
    ).not.toBeNull();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="accounts-add"]')!
        .click();
      await Promise.resolve();
    });

    expect(initiateDeviceFlow).toHaveBeenCalledTimes(2);
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

  it("renders the display settings panel with both checkboxes", async () => {
    await renderOptionsPage();
    expect(
      document.querySelector('[data-testid="prefs-show-state-badge"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="prefs-show-reviewer-name"]'),
    ).not.toBeNull();
  });

  it("reflects stored preferences in checkbox state on mount", async () => {
    getPreferencesMock.mockResolvedValueOnce({
      version: 1,
      showStateBadge: false,
      showReviewerName: true,
    });
    await renderOptionsPage();
    const badgeCheckbox = document.querySelector<HTMLInputElement>(
      '[data-testid="prefs-show-state-badge"]',
    )!;
    const nameCheckbox = document.querySelector<HTMLInputElement>(
      '[data-testid="prefs-show-reviewer-name"]',
    )!;
    expect(badgeCheckbox.checked).toBe(false);
    expect(nameCheckbox.checked).toBe(true);
  });

  it("calls updatePreferences when a checkbox is toggled", async () => {
    await renderOptionsPage();
    const badgeCheckbox = document.querySelector<HTMLInputElement>(
      '[data-testid="prefs-show-state-badge"]',
    )!;
    await act(async () => {
      badgeCheckbox.click();
      await Promise.resolve();
    });
    expect(updatePreferencesMock).toHaveBeenCalledWith({ showStateBadge: false });
  });
});
