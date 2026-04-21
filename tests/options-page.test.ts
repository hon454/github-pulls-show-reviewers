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

beforeEach(() => {
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
});
