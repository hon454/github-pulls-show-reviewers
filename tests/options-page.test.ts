// @vitest-environment jsdom

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const getStoredSettingsMock = vi.fn(async () => ({ githubToken: null }));
const saveStoredSettingsMock = vi.fn(async () => {});
const validateGitHubTokenMock = vi.fn();
const validateGitHubRepositoryAccessMock = vi.fn();

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

  await act(async () => {
    await import("../entrypoints/options/main");
  });
}

describe("options page", () => {
  beforeEach(() => {
    getStoredSettingsMock.mockClear();
    saveStoredSettingsMock.mockClear();
    validateGitHubTokenMock.mockClear();
    validateGitHubRepositoryAccessMock.mockClear();
  });

  it("starts with an empty repository access check field", async () => {
    await renderOptionsPage();

    const input = document.querySelector<HTMLInputElement>("#repository-check");
    expect(input).not.toBeNull();
    expect(input?.value).toBe("");
  });

  it("renders a fine-grained PAT creation link in the token section", async () => {
    await renderOptionsPage();

    const link = document.querySelector<HTMLAnchorElement>(
      'a[href*="github.com/settings/personal-access-tokens/new"]',
    );

    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Create fine-grained PAT");
    expect(link?.href).toContain("pull_requests=read");
  });
});
