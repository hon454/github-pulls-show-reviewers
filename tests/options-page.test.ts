// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLocaleStore,
  type LanguagePreference,
  type LocaleStore,
} from "../src/i18n";
import type { Root } from "react-dom/client";

import type * as GitHubApiModule from "../src/github/api";
import type { RepositoryValidationResult } from "../src/github/api";
import type { Account } from "../src/storage/accounts";
import type * as AccountsModule from "../src/storage/accounts";

type AccountsModuleType = typeof AccountsModule;
type GitHubApiModuleType = typeof GitHubApiModule;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const listAccountsMock = vi.fn<() => Promise<Account[]>>(async () => []);
const getAccountByIdMock = vi.fn<() => Promise<Account | null>>(
  async () => null,
);
const removeAccountMock = vi.fn(async () => {});
const replaceInstallationsMock = vi.fn(async () => {});
const resolveAccountForRepoMock = vi.fn(async () => null);
const resolveAccountCoverageForRepoMock = vi.fn<
  AccountsModuleType["resolveAccountCoverageForRepo"]
>(async () => ({
  status: "uncovered",
}));

const getPreferencesMock = vi.fn(async () => ({
  version: 1 as const,
  language: "auto" as const,
  showStateBadge: true,
  showReviewerName: false,
  openPullsOnly: true,
}));
const updatePreferencesMock = vi.fn(async (patch: Record<string, unknown>) => ({
  version: 1 as const,
  language: "auto" as const,
  showStateBadge: true,
  showReviewerName: false,
  openPullsOnly: true,
  ...patch,
}));

vi.mock("../src/storage/accounts", async (importActual) => {
  const actual = await importActual<AccountsModuleType>();
  return {
    ...actual,
    listAccounts: listAccountsMock,
    addAccount: vi.fn(async () => {}),
    upsertAccountByLogin: vi.fn(async (input: Record<string, unknown>) => ({
      id: input.newAccountId,
      login: input.login,
      avatarUrl: input.avatarUrl,
      createdAt: input.now,
      token: input.token,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt,
      installations: input.installations,
      installationsRefreshedAt: input.now,
      invalidated: false,
      invalidatedReason: null,
    })),
    removeAccount: removeAccountMock,
    replaceInstallations: replaceInstallationsMock,
    getAccountById: getAccountByIdMock,
    resolveAccountForRepo: resolveAccountForRepoMock,
    resolveAccountCoverageForRepo: resolveAccountCoverageForRepoMock,
  };
});

vi.mock("../src/storage/preferences", () => ({
  getPreferences: getPreferencesMock,
  updatePreferences: updatePreferencesMock,
  DEFAULT_PREFERENCES: {
    version: 1,
    language: "auto",
    showStateBadge: true,
    showReviewerName: false,
    openPullsOnly: true,
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

const validateGitHubRepositoryAccessMock = vi.fn(async () =>
  validationResult({ message: "Repository is accessible." }),
);

vi.mock("../src/github/api", async (importActual) => ({
  ...(await importActual<GitHubApiModuleType>()),
  validateGitHubRepositoryAccess: validateGitHubRepositoryAccessMock,
}));

const mountedRoots: Root[] = [];
async function renderOptionsPage(localeStore?: LocaleStore) {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  const [{ createRoot }, { OptionsPage }] = await Promise.all([
    import("react-dom/client"),
    import("../entrypoints/options/options-page"),
  ]);
  await act(async () => {
    const root = createRoot(document.getElementById("root")!);
    mountedRoots.push(root);
    root.render(createElement(OptionsPage, localeStore ? { localeStore } : {}));
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
    const root = createRoot(document.getElementById("root")!);
    mountedRoots.push(root);
    root.render(createElement(StrictMode, null, createElement(OptionsPage)));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function account(partial: Partial<Account> = {}): Account {
  return {
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
    ...partial,
  };
}

function validationResult(
  partial: Partial<RepositoryValidationResult> = {},
): RepositoryValidationResult {
  return {
    ok: true,
    authMode: "token",
    outcome: "accessible",
    message: "Repository diagnostics checked pull #12 in cinev/shotloom.",
    fullName: "cinev/shotloom",
    pullNumber: "12",
    ...partial,
  } as RepositoryValidationResult;
}

beforeEach(() => {
  // `vi.mock` factory results are cached across `vi.resetModules()` in
  // this file (module cache is reset but factory outputs are reused), so
  // auth mock call history leaks between tests unless cleared here.
  vi.clearAllMocks();
  listAccountsMock.mockReset();
  getAccountByIdMock.mockReset();
  removeAccountMock.mockReset();
  replaceInstallationsMock.mockReset();
  resolveAccountForRepoMock.mockReset();
  resolveAccountCoverageForRepoMock.mockReset();
  listAccountsMock.mockResolvedValue([]);
  getAccountByIdMock.mockResolvedValue(null);
  removeAccountMock.mockResolvedValue(undefined);
  getPreferencesMock.mockClear();
  updatePreferencesMock.mockClear();
  getPreferencesMock.mockResolvedValue({
    version: 1,
    language: "auto",
    showStateBadge: true,
    showReviewerName: false,
    openPullsOnly: true,
  });
  updatePreferencesMock.mockResolvedValue({
    version: 1,
    language: "auto",
    showStateBadge: true,
    showReviewerName: false,
    openPullsOnly: true,
  });
  resolveAccountForRepoMock.mockResolvedValue(null);
  resolveAccountCoverageForRepoMock.mockResolvedValue({ status: "uncovered" });
  validateGitHubRepositoryAccessMock.mockResolvedValue(
    validationResult({ message: "Repository is accessible." }),
  );
  vi.stubGlobal("browser", {
    i18n: { getUILanguage: () => "en-US" },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
    runtime: {
      sendMessage: vi.fn(),
    },
  });
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
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

  it("gives the diagnostics repository input an associated label", async () => {
    await renderOptionsPage();

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="diagnostics-repo"]',
    );

    expect(input).not.toBeNull();
    expect(input!.labels).toHaveLength(1);
    expect(input!.labels![0]?.textContent).toContain("Repository");
    expect(input!.labels![0]?.textContent).toContain("owner/name");
  });

  it("surfaces incomplete selected-installation snapshots in matched diagnostics", async () => {
    const matchedAccount = account({
      installations: [
        {
          id: 42,
          account: { login: "cinev", type: "Organization", avatarUrl: null },
          repositorySelection: "selected",
          repoSnapshot: {
            fullNames: ["cinev/landing"],
            completeness: "truncated",
          },
        },
      ],
    });
    resolveAccountCoverageForRepoMock.mockResolvedValueOnce({
      status: "maybe-covered-truncated",
      account: matchedAccount,
    });
    await renderOptionsPage();

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="diagnostics-repo"]',
    )!;
    const matchedButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="diagnostics-matched"]',
    )!;

    await act(async () => {
      fireEvent.change(input, { target: { value: "cinev/shotloom" } });
      await Promise.resolve();
    });

    await act(async () => {
      matchedButton.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(resolveAccountCoverageForRepoMock).toHaveBeenCalledWith(
      "cinev",
      "shotloom",
    );
    expect(validateGitHubRepositoryAccessMock).toHaveBeenCalledWith(
      matchedAccount,
      "cinev/shotloom",
    );
    expect(
      document.querySelector('[data-testid="diagnostics-fields"]')?.textContent,
    ).toContain(
      "Installation coverageMaybe covered - local snapshot truncated",
    );
  });

  it("renders structured diagnostics for a matched account success", async () => {
    const matchedAccount = account();
    resolveAccountCoverageForRepoMock.mockResolvedValueOnce({
      status: "covered",
      account: matchedAccount,
    });
    validateGitHubRepositoryAccessMock.mockResolvedValueOnce(
      validationResult(),
    );
    await renderOptionsPage();

    await act(async () => {
      fireEvent.change(
        document.querySelector<HTMLInputElement>(
          '[data-testid="diagnostics-repo"]',
        )!,
        { target: { value: "cinev/shotloom" } },
      );
      await Promise.resolve();
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="diagnostics-matched"]',
        )!
        .click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      document.querySelector('[data-testid="diagnostics-status"]')?.textContent,
    ).toContain("checked pull #12");
    const fields = document.querySelector('[data-testid="diagnostics-fields"]');
    expect(fields?.textContent).toContain("Matched account@hon454");
    expect(fields?.textContent).toContain("Auth modeMatched account token");
    expect(fields?.textContent).toContain("Installation coverageCovered");
    expect(fields?.textContent).toContain("Endpoint resultAccessible");
  });

  it("renders uncovered installation diagnostics without repository validation", async () => {
    resolveAccountCoverageForRepoMock.mockResolvedValueOnce({
      status: "uncovered",
    });
    await renderOptionsPage();

    await act(async () => {
      fireEvent.change(
        document.querySelector<HTMLInputElement>(
          '[data-testid="diagnostics-repo"]',
        )!,
        { target: { value: "cinev/shotloom" } },
      );
      await Promise.resolve();
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="diagnostics-matched"]',
        )!
        .click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(validateGitHubRepositoryAccessMock).not.toHaveBeenCalled();
    const fields = document.querySelector('[data-testid="diagnostics-fields"]');
    expect(fields?.textContent).toContain("Matched accountNone");
    expect(fields?.textContent).toContain("Auth modeNot checked");
    expect(fields?.textContent).toContain("Installation coverageUncovered");
    expect(fields?.textContent).toContain("Endpoint resultNot checked");
  });

  it("renders no-token rate-limit diagnostics", async () => {
    validateGitHubRepositoryAccessMock.mockResolvedValueOnce(
      validationResult({
        ok: false,
        authMode: "no-token",
        outcome: "unauthenticated-rate-limit",
        message: "Repository diagnostics hit the unauthenticated rate limit.",
        fullName: "cinev/shotloom",
        rateLimit: {
          limit: 60,
          remaining: 0,
          resource: "core",
          resetAt: 1710000000,
        },
      }),
    );
    await renderOptionsPage();

    await act(async () => {
      fireEvent.change(
        document.querySelector<HTMLInputElement>(
          '[data-testid="diagnostics-repo"]',
        )!,
        { target: { value: "cinev/shotloom" } },
      );
      await Promise.resolve();
    });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="diagnostics-no-token"]',
        )!
        .click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const fields = document.querySelector('[data-testid="diagnostics-fields"]');
    expect(fields?.textContent).toContain("Matched accountNot checked");
    expect(fields?.textContent).toContain("Auth modeNo token");
    expect(fields?.textContent).toContain(
      "Endpoint resultUnauthenticated rate limit",
    );
    expect(fields?.textContent).toContain(
      "Rate limit0 of 60 remainingRate-limit resourcecoreRate-limit reset2024-03-09 16:00 UTC",
    );
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
      .mockRejectedValueOnce(
        new Error("GET /user/installations failed with status 401."),
      )
      .mockResolvedValueOnce({
        items: [
          {
            id: 42,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
          },
        ],
        truncated: false,
      });
    fetchInstallationRepositories.mockResolvedValueOnce({
      items: ["cinev/shotloom"],
      truncated: false,
    });

    const sendMessageMock = vi
      .fn()
      .mockResolvedValue({ ok: true, token: "ghu_new" });
    vi.stubGlobal("browser", {
      i18n: { getUILanguage: () => "en-US" },
      storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
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
        repoSnapshot: {
          fullNames: ["cinev/shotloom"],
          completeness: "complete",
        },
      },
    ]);
  });

  it("shows an inline error and re-enables account actions when refresh fails", async () => {
    listAccountsMock.mockResolvedValue([
      {
        id: "acc",
        login: "hon454",
        avatarUrl: null,
        token: "ghu_old",
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

    const auth = await import("../src/github/auth");
    const fetchUserInstallations =
      auth.fetchUserInstallations as unknown as ReturnType<typeof vi.fn>;
    fetchUserInstallations.mockRejectedValueOnce(
      new Error("GitHub API temporarily unavailable."),
    );

    const refreshButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Refresh installations");
    expect(refreshButton).toBeDefined();

    await act(async () => {
      refreshButton!.click();
      refreshButton!.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchUserInstallations).toHaveBeenCalledTimes(1);
    expect(refreshButton!.disabled).toBe(false);
    expect(
      document.querySelector('[data-testid="account-action-error-acc"]')
        ?.textContent,
    ).toContain("Could not refresh installations");
  });

  it("shows an inline error and prevents duplicate remove clicks while removing an account", async () => {
    listAccountsMock.mockResolvedValue([
      {
        id: "acc",
        login: "hon454",
        avatarUrl: null,
        token: "ghu_old",
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
    removeAccountMock.mockRejectedValueOnce(new Error("Storage write failed."));
    await renderOptionsPage();

    const removeButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.trim() === "Remove");
    expect(removeButton).toBeDefined();

    await act(async () => {
      removeButton!.click();
      removeButton!.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(removeAccountMock).toHaveBeenCalledTimes(1);
    expect(removeButton!.disabled).toBe(false);
    expect(
      document.querySelector('[data-testid="account-action-error-acc"]')
        ?.textContent,
    ).toContain("Could not remove account");
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
    const initiateDeviceFlow = auth.initiateDeviceFlow as unknown as ReturnType<
      typeof vi.fn
    >;
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
    const initiateDeviceFlow = auth.initiateDeviceFlow as unknown as ReturnType<
      typeof vi.fn
    >;
    const pollForAccessToken = auth.pollForAccessToken as unknown as ReturnType<
      typeof vi.fn
    >;
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
    fetchUserInstallations.mockResolvedValue({ items: [], truncated: false });

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
    const initiateDeviceFlow = auth.initiateDeviceFlow as unknown as ReturnType<
      typeof vi.fn
    >;
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

  it("renders the display settings panel with all checkboxes", async () => {
    await renderOptionsPage();
    expect(
      document.querySelector('[data-testid="prefs-show-state-badge"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="prefs-show-reviewer-name"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="prefs-open-pulls-only"]'),
    ).not.toBeNull();
  });

  it("reflects stored preferences in checkbox state on mount", async () => {
    getPreferencesMock.mockResolvedValueOnce({
      version: 1,
      language: "auto",
      showStateBadge: false,
      showReviewerName: true,
      openPullsOnly: false,
    });
    await renderOptionsPage();
    const badgeCheckbox = document.querySelector<HTMLInputElement>(
      '[data-testid="prefs-show-state-badge"]',
    )!;
    const nameCheckbox = document.querySelector<HTMLInputElement>(
      '[data-testid="prefs-show-reviewer-name"]',
    )!;
    const openOnlyCheckbox = document.querySelector<HTMLInputElement>(
      '[data-testid="prefs-open-pulls-only"]',
    )!;
    expect(badgeCheckbox.checked).toBe(false);
    expect(nameCheckbox.checked).toBe(true);
    expect(openOnlyCheckbox.checked).toBe(false);
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
    expect(updatePreferencesMock).toHaveBeenCalledWith({
      showStateBadge: false,
    });
  });

  it("shows an inline error and reverts checkbox state when a preference update fails", async () => {
    updatePreferencesMock.mockRejectedValueOnce(
      new Error("Storage write failed."),
    );
    await renderOptionsPage();
    const badgeCheckbox = document.querySelector<HTMLInputElement>(
      '[data-testid="prefs-show-state-badge"]',
    )!;

    await act(async () => {
      badgeCheckbox.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(updatePreferencesMock).toHaveBeenCalledWith({
      showStateBadge: false,
    });
    expect(badgeCheckbox.checked).toBe(true);
    expect(
      document.querySelector('[data-testid="prefs-error"]')?.textContent,
    ).toContain("Could not save display settings");
  });

  it("shows an inline diagnostics error and re-enables buttons when no-token validation throws", async () => {
    validateGitHubRepositoryAccessMock.mockRejectedValueOnce(
      new Error("Network offline."),
    );
    await renderOptionsPage();

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="diagnostics-repo"]',
    )!;
    const noTokenButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="diagnostics-no-token"]',
    )!;

    await act(async () => {
      fireEvent.change(input, {
        target: { value: "hon454/github-pulls-show-reviewers" },
      });
      await Promise.resolve();
    });

    await act(async () => {
      noTokenButton.click();
      noTokenButton.click();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(validateGitHubRepositoryAccessMock).toHaveBeenCalledTimes(1);
    expect(noTokenButton.disabled).toBe(false);
    expect(
      document.querySelector('[data-testid="diagnostics-status"]')?.textContent,
    ).toContain("Could not run diagnostics");
  });
});

function languageHarness(
  initial: LanguagePreference = "auto",
  chromeLanguage = "en-US",
) {
  let language = initial;
  const listeners = new Set<(next: LanguagePreference) => void>();
  const save = vi.fn<(next: LanguagePreference) => Promise<void>>(
    async () => undefined,
  );
  const newStore = () =>
    createLocaleStore({
      getUILanguage: () => chromeLanguage,
      readLanguage: async () => language,
      writeLanguage: async (next) => {
        await save(next);
        language = next;
        for (const listener of listeners) listener(next);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
  return { store: newStore(), newStore, save, listeners };
}
async function chooseLanguage(language: LanguagePreference) {
  await act(async () => {
    fireEvent.change(
      document.querySelector('[data-testid="language-select"]')!,
      { target: { value: language } },
    );
    await Promise.resolve();
  });
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("options live language selection", () => {
  it.each([
    ["en", "GitHub accounts", "Display", "Settings —"],
    ["ko", "GitHub 계정", "표시", "설정 —"],
    ["ja", "GitHubアカウント", "表示", "設定 —"],
    ["zh_CN", "GitHub 账号", "显示", "设置 —"],
    ["zh_TW", "GitHub 帳號", "顯示", "設定 —"],
  ] as const)(
    "renders meaningful %s shell/display copy and document metadata",
    async (language, accounts, display, title) => {
      const h = languageHarness(language);
      await renderOptionsPage(h.store);
      expect(document.querySelector("#accounts-title")?.textContent).toBe(
        accounts,
      );
      expect(document.querySelector("#display-title")?.textContent).toBe(
        display,
      );
      expect(document.documentElement.lang).toBe(language.replace("_", "-"));
      expect(document.title).toContain(title);
      expect(
        document.querySelector<HTMLSelectElement>("#language-select")!.labels,
      ).toHaveLength(1);
      expect(document.body.textContent).toContain("Pull requests: Read");
      expect(document.body.textContent).not.toContain("__MSG_");
    },
  );

  it("persists manual and auto selection, updates another context, and falls back for unsupported Chrome language", async () => {
    const h = languageHarness("auto", "fr-FR");
    const other = h.newStore();
    const notify = vi.fn();
    const stop = other.subscribe(notify);
    await other.ready();
    await renderOptionsPage(h.store);
    expect(document.documentElement.lang).toBe("en");
    await chooseLanguage("ko");
    expect(h.save).toHaveBeenCalledWith("ko");
    expect(other.getSnapshot().locale).toBe("ko");
    expect(document.querySelector("#language-status")?.textContent).toBe(
      "언어를 저장했습니다.",
    );
    await chooseLanguage("auto");
    expect(document.documentElement.lang).toBe("en");
    expect(other.getSnapshot().language).toBe("auto");
    expect(notify).toHaveBeenCalledTimes(2);
    stop();
    const reopened = h.newStore();
    await reopened.ready();
    expect(reopened.getSnapshot().language).toBe("auto");
  });

  it("keeps the persisted selection on save failure and localizes the visible error on a remote update", async () => {
    const h = languageHarness();
    h.save.mockRejectedValueOnce(new Error("private browser details"));
    await renderOptionsPage(h.store);
    await chooseLanguage("ja");
    const select =
      document.querySelector<HTMLSelectElement>("#language-select")!;
    expect(select.value).toBe("auto");
    expect(select.disabled).toBe(false);
    expect(document.querySelector("#language-status")?.textContent).toContain(
      "Could not save language",
    );
    expect(document.body.textContent).not.toContain("private browser details");
    const other = h.newStore();
    await act(() => other.setLanguage("ko"));
    expect(select.value).toBe("ko");
    expect(document.querySelector("#language-status")?.textContent).toContain(
      "언어를 저장하지 못했습니다",
    );
  });

  it("preserves pending device initiation, device code, repository input and cancellation across switches", async () => {
    const h = languageHarness();
    await renderOptionsPage(h.store);
    const auth = await import("../src/github/auth");
    const init = pending<Awaited<ReturnType<typeof auth.initiateDeviceFlow>>>();
    vi.mocked(auth.initiateDeviceFlow).mockReturnValueOnce(init.promise);
    const repository = document.querySelector<HTMLInputElement>(
      '[data-testid="diagnostics-repo"]',
    )!;
    fireEvent.change(repository, {
      target: { value: "owner/repository-kept" },
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="accounts-add"]')!
        .click();
    });
    await chooseLanguage("ko");
    expect(document.body.textContent).toContain("기기 코드 요청 중");
    expect(auth.initiateDeviceFlow).toHaveBeenCalledTimes(1);
    await act(async () => {
      init.resolve({
        deviceCode: "dc",
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
        verificationUriComplete:
          "https://github.com/login/device?user_code=ABCD-EFGH",
        interval: 60,
        expiresIn: 900,
      });
    });
    const code = document.querySelector('[data-testid="device-user-code"]');
    await chooseLanguage("ja");
    expect(document.querySelector('[data-testid="device-user-code"]')).toBe(
      code,
    );
    expect(code?.textContent).toBe("ABCD-EFGH");
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="diagnostics-repo"]',
      ),
    ).toBe(repository);
    expect(repository.value).toBe("owner/repository-kept");
    expect(document.body.textContent).toContain("認可を待っています");
    expect(
      document.querySelector<HTMLAnchorElement>(".authorization-link")?.href,
    ).toBe("https://github.com/login/device?user_code=ABCD-EFGH");
    expect(auth.initiateDeviceFlow).toHaveBeenCalledTimes(1);
    expect(auth.pollForAccessToken).not.toHaveBeenCalled();
    expect(listAccountsMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "キャンセル")!
        .click();
    });
    expect(
      document.querySelector('[data-testid="device-user-code"]'),
    ).toBeNull();
  });

  it("keeps an in-flight account refresh and its eventual error while changing language", async () => {
    const h = languageHarness();
    const existing = account();
    listAccountsMock.mockResolvedValue([existing]);
    getAccountByIdMock.mockResolvedValue(existing);
    await renderOptionsPage(h.store);
    const auth = await import("../src/github/auth");
    const result =
      pending<Awaited<ReturnType<typeof auth.fetchUserInstallations>>>();
    vi.mocked(auth.fetchUserInstallations).mockReturnValueOnce(result.promise);
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Refresh installations")!
        .click();
    });
    await chooseLanguage("ko");
    expect(document.body.textContent).toContain("새로고침 중");
    expect(
      document.querySelector('[data-testid="account-card-hon454"]'),
    ).not.toBeNull();
    expect(auth.fetchUserInstallations).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.resolve({ items: [], truncated: false });
    });
    expect(replaceInstallationsMock).toHaveBeenCalledTimes(1);
    expect(auth.fetchUserInstallations).toHaveBeenCalledTimes(1);
    removeAccountMock.mockRejectedValueOnce(
      new Error("unknown technical failure"),
    );
    await act(async () => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "삭제")!
        .click();
    });
    expect(
      document.querySelector('[data-testid="account-action-error-acc"]')
        ?.textContent,
    ).toContain("계정을 삭제하지 못했습니다");
    await chooseLanguage("en");
    expect(
      document.querySelector('[data-testid="account-action-error-acc"]')
        ?.textContent,
    ).toContain("Could not remove account");
    expect(removeAccountMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(
      "unknown technical failure",
    );
  });

  it("reformats display saving/error and account load failure without reloading on language changes", async () => {
    const h = languageHarness();
    listAccountsMock.mockRejectedValueOnce(
      new Error("unknown storage failure"),
    );
    await renderOptionsPage(h.store);
    expect(document.body.textContent).toContain("Could not load accounts");
    const saving = pending<Awaited<ReturnType<typeof updatePreferencesMock>>>();
    updatePreferencesMock.mockReturnValueOnce(saving.promise);
    await act(async () => {
      document
        .querySelector<HTMLInputElement>(
          '[data-testid="prefs-show-state-badge"]',
        )!
        .click();
    });
    await chooseLanguage("ko");
    expect(document.body.textContent).toContain("표시 설정 저장 중");
    expect(document.body.textContent).toContain("계정을 불러오지 못했습니다");
    expect(listAccountsMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      saving.resolve({
        version: 1,
        language: "auto",
        showStateBadge: false,
        showReviewerName: false,
        openPullsOnly: true,
      });
    });
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="prefs-show-state-badge"]',
      )!.checked,
    ).toBe(false);
    updatePreferencesMock.mockRejectedValueOnce(
      new Error("not translated evidence"),
    );
    await act(async () => {
      document
        .querySelector<HTMLInputElement>(
          '[data-testid="prefs-show-reviewer-name"]',
        )!
        .click();
    });
    await chooseLanguage("ja");
    expect(
      document.querySelector('[data-testid="prefs-error"]')?.textContent,
    ).toContain("表示設定を保存できませんでした");
    expect(updatePreferencesMock).toHaveBeenCalledTimes(2);
  });
});

describe("diagnostic render-only language changes", () => {
  it.each(["matched", "no-token"] as const)(
    "keeps the %s request, result and input across five languages",
    async (mode) => {
      const h = languageHarness();
      const existing = account();
      getAccountByIdMock.mockResolvedValue(existing);
      resolveAccountCoverageForRepoMock.mockResolvedValue({
        status: "maybe-covered-truncated",
        account: existing,
      });
      const request = pending<RepositoryValidationResult>();
      validateGitHubRepositoryAccessMock.mockReturnValueOnce(request.promise);
      await renderOptionsPage(h.store);
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="diagnostics-repo"]',
      )!;
      fireEvent.change(input, { target: { value: "cinev/shotloom" } });
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            `[data-testid="diagnostics-${mode}"]`,
          )!
          .click(),
      );
      for (const language of ["ko", "ja", "zh_CN", "zh_TW", "en"] as const) {
        await chooseLanguage(language);
        expect(
          document.querySelector('[data-testid="diagnostics-status"]')
            ?.textContent,
        ).toBe(h.store.getSnapshot().t("diagnostics_running"));
        expect(
          document.querySelector<HTMLButtonElement>(
            '[data-testid="diagnostics-no-token"]',
          )!.disabled,
        ).toBe(true);
        expect(
          document.querySelector<HTMLButtonElement>(
            '[data-testid="diagnostics-matched"]',
          )!.disabled,
        ).toBe(true);
        expect(validateGitHubRepositoryAccessMock).toHaveBeenCalledTimes(1);
        expect(input.value).toBe("cinev/shotloom");
      }
      await act(async () =>
        request.resolve(
          validationResult({
            ok: false,
            authMode: mode === "matched" ? "token" : "no-token",
            outcome:
              mode === "matched"
                ? "authenticated-rate-limit"
                : "unauthenticated-rate-limit",
            message: "private raw API details",
            failures: [
              {
                kind: "http",
                httpStatus: 403,
                endpoint: {
                  name: "pull",
                  method: "GET",
                  path: "/repos/cinev/shotloom/pulls/12",
                },
              },
              {
                kind: "http",
                httpStatus: 429,
                endpoint: {
                  name: "reviews",
                  method: "GET",
                  path: "/repos/cinev/shotloom/pulls/12/reviews",
                },
                rateLimit: {
                  limit: 60,
                  remaining: 0,
                  resource: "core",
                  resetAt: 1710000000,
                },
              },
            ],
          }),
        ),
      );
      const status = document.querySelector(
        '[data-testid="diagnostics-status"]',
      );
      for (const language of ["ko", "ja", "zh_CN", "zh_TW", "en"] as const) {
        await chooseLanguage(language);
        const t = h.store.getSnapshot().t;
        expect(status?.textContent).toBe(
          t(
            mode === "matched"
              ? "diagnostics_token_rate"
              : "diagnostics_no_token_rate",
            { repository: "cinev/shotloom" },
          ),
        );
        const fields = document.querySelector(
          '[data-testid="diagnostics-fields"]',
        )!;
        expect(fields.textContent).toContain(
          "GET /repos/cinev/shotloom/pulls/12",
        );
        expect(fields.textContent).toContain(
          "GET /repos/cinev/shotloom/pulls/12/reviews",
        );
        expect(fields.textContent).toContain("HTTP 403");
        expect(fields.textContent).toContain("HTTP 429");
        expect(fields.textContent).toContain("2024-03-09 16:00 UTC");
        expect(fields.textContent).toContain(
          t("diagnostics_rate_quota", { remaining: 0, limit: 60 }),
        );
        expect(document.body.textContent).not.toContain(
          "private raw API details",
        );
        expect(document.querySelector('[data-testid="diagnostics-repo"]')).toBe(
          input,
        );
        expect(input.value).toBe("cinev/shotloom");
        expect(
          document.querySelector<HTMLButtonElement>(
            '[data-testid="diagnostics-no-token"]',
          )!.disabled,
        ).toBe(false);
      }
      expect(validateGitHubRepositoryAccessMock).toHaveBeenCalledTimes(1);
      expect(resolveAccountCoverageForRepoMock).toHaveBeenCalledTimes(
        mode === "matched" ? 1 : 0,
      );
    },
  );

  it("translates input validation, uncovered coverage and unknown errors without leaking error prose", async () => {
    const h = languageHarness();
    await renderOptionsPage(h.store);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="diagnostics-matched"]',
        )!
        .click(),
    );
    await chooseLanguage("ko");
    const status = () =>
      document.querySelector('[data-testid="diagnostics-status"]')?.textContent;
    expect(status()).toBe(h.store.getSnapshot().t("diagnostics_input_matched"));
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="diagnostics-no-token"]',
        )!
        .click(),
    );
    await chooseLanguage("ja");
    expect(status()).toBe(
      h.store.getSnapshot().t("diagnostics_input_no_token"),
    );
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="diagnostics-repo"]',
    )!;
    fireEvent.change(input, { target: { value: "cinev/shotloom" } });
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="diagnostics-matched"]',
        )!
        .click(),
    );
    await chooseLanguage("zh_CN");
    expect(status()).toBe(
      h.store
        .getSnapshot()
        .t("diagnostics_uncovered", { repository: "cinev/shotloom" }),
    );
    expect(validateGitHubRepositoryAccessMock).not.toHaveBeenCalled();
    validateGitHubRepositoryAccessMock.mockRejectedValueOnce(
      new Error("private request credentials"),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="diagnostics-no-token"]',
        )!
        .click(),
    );
    await chooseLanguage("zh_TW");
    expect(status()).toBe(h.store.getSnapshot().t("diagnostics_run_failed"));
    expect(document.body.textContent).not.toContain(
      "private request credentials",
    );
    expect(validateGitHubRepositoryAccessMock).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="diagnostics-no-token"]',
      )!.disabled,
    ).toBe(false);
  });
});
