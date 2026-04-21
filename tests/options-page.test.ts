// @vitest-environment jsdom

import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RepositoryValidationResult,
  TokenValidationResult,
} from "../src/github/api";
import type { ExtensionSettings } from "../src/storage/settings";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const getStoredSettingsMock = vi.fn<() => Promise<ExtensionSettings>>(
  async () => ({ tokenEntries: [] }),
);
const saveStoredSettingsMock = vi.fn<
  (settings: ExtensionSettings) => Promise<void>
>(async () => {});
const validateGitHubTokenMock = vi.fn<
  (token: string) => Promise<TokenValidationResult>
>();
const validateGitHubRepositoryAccessMock = vi.fn<
  (
    token: string | null,
    repository: string,
  ) => Promise<RepositoryValidationResult>
>();

vi.mock("../src/storage/settings", () => ({
  getStoredSettings: getStoredSettingsMock,
  saveStoredSettings: saveStoredSettingsMock,
}));

vi.mock("../src/github/api", () => ({
  validateGitHubToken: validateGitHubTokenMock,
  validateGitHubRepositoryAccess: validateGitHubRepositoryAccessMock,
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

async function changeInputValue(
  input: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      input instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLSelectElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(
      prototype,
      "value",
    )?.set;

    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("options page", () => {
  beforeEach(() => {
    getStoredSettingsMock.mockReset();
    getStoredSettingsMock.mockResolvedValue({ tokenEntries: [] });
    saveStoredSettingsMock.mockReset();
    saveStoredSettingsMock.mockResolvedValue(undefined);
    validateGitHubTokenMock.mockReset();
    validateGitHubRepositoryAccessMock.mockReset();
  });

  it("starts with an empty repository access check field", async () => {
    await renderOptionsPage();

    const input = document.querySelector<HTMLInputElement>("#repository-check");
    expect(input).not.toBeNull();
    expect(input?.value).toBe("");
  });

  it("renders a classic PAT creation link in the token section", async () => {
    await renderOptionsPage();

    const link = document.querySelector<HTMLAnchorElement>(
      'a[href*="github.com/settings/tokens/new"]',
    );

    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Create classic PAT");
    expect(link?.href).toContain("scopes=repo");
    expect(link?.href).toContain("description=");
  });

  it("shows SSO authorization guidance in the token section", async () => {
    await renderOptionsPage();

    expect(document.body.textContent).toContain("Configure SSO");
    expect(document.body.textContent).toContain("Authorize");
    expect(document.body.textContent).toContain("public_repo");
  });

  it("renders saved token scopes from storage", async () => {
    getStoredSettingsMock.mockResolvedValue({
      tokenEntries: [
        {
          id: "scope-1",
          scope: "hon454/*",
          token: "github_pat_1234567890",
          label: "Personal",
        },
      ],
    });

    await renderOptionsPage();

    expect(document.body.textContent).toContain("Saved token scopes");
    expect(document.body.textContent).toContain("hon454");
    expect(document.body.textContent).toContain("All repos under this owner");
    expect(document.body.textContent).toContain("Personal");
    expect(document.body.textContent).toContain("••••7890");
  });

  it("shows the repository field only for single-repository scope", async () => {
    await renderOptionsPage();

    expect(
      document.querySelector<HTMLInputElement>("#token-repo"),
    ).toBeNull();

    const select = document.querySelector<HTMLSelectElement>("#scope-type");
    expect(select).not.toBeNull();

    await changeInputValue(select!, "repo");

    expect(
      document.querySelector<HTMLInputElement>("#token-repo"),
    ).not.toBeNull();
  });

  it("blocks duplicate scopes before validating and saving", async () => {
    getStoredSettingsMock.mockResolvedValue({
      tokenEntries: [
        {
          id: "scope-1",
          scope: "hon454/*",
          token: "github_pat_existing",
          label: null,
        },
      ],
    });

    await renderOptionsPage();

    const owner = document.querySelector<HTMLInputElement>("#token-owner");
    const token = document.querySelector<HTMLInputElement>("#token-value");
    const saveButton = document.querySelector<HTMLButtonElement>(
      'button[data-testid="validate-save-token"]',
    );

    expect(owner).not.toBeNull();
    expect(token).not.toBeNull();
    expect(saveButton).not.toBeNull();

    await changeInputValue(owner!, "hon454");
    await changeInputValue(token!, "github_pat_new");

    await act(async () => {
      saveButton!.click();
      await Promise.resolve();
    });

    expect(validateGitHubTokenMock).not.toHaveBeenCalled();
    expect(saveStoredSettingsMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "A token for hon454/* is already saved.",
    );
  });

  it("reports when no stored token matches the repository access check", async () => {
    await renderOptionsPage();

    const repository = document.querySelector<HTMLInputElement>("#repository-check");
    const button = document.querySelector<HTMLButtonElement>(
      'button[data-testid="check-matched-token"]',
    );

    expect(repository).not.toBeNull();
    expect(button).not.toBeNull();

    await changeInputValue(repository!, "hon454/github-pulls-show-reviewers");

    await act(async () => {
      button!.click();
      await Promise.resolve();
    });

    expect(validateGitHubRepositoryAccessMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "No saved token matches hon454/github-pulls-show-reviewers.",
    );
  });
});
