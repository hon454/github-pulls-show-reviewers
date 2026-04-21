import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("github-app config", () => {
  it("exports dev defaults when running outside production", async () => {
    vi.stubGlobal("__GITHUB_APP_CLIENT_ID__", "dev-client-id");
    vi.stubGlobal("__GITHUB_APP_SLUG__", "dev-slug");
    vi.stubGlobal("__GITHUB_APP_NAME__", "Dev App");
    vi.stubGlobal("__PROD__", false);

    const { getGitHubAppConfig } = await import("../src/config/github-app");
    expect(getGitHubAppConfig()).toEqual({
      clientId: "dev-client-id",
      slug: "dev-slug",
      name: "Dev App",
    });
  });

  it("throws when a required value is missing in production", async () => {
    vi.stubGlobal("__GITHUB_APP_CLIENT_ID__", "");
    vi.stubGlobal("__GITHUB_APP_SLUG__", "");
    vi.stubGlobal("__GITHUB_APP_NAME__", "");
    vi.stubGlobal("__PROD__", true);

    const mod = await import("../src/config/github-app");
    expect(() => mod.getGitHubAppConfig()).toThrow(
      /WXT_GITHUB_APP_CLIENT_ID/,
    );
  });

  it("falls back to sensible dev defaults when the globals are undefined", async () => {
    vi.stubGlobal("__GITHUB_APP_CLIENT_ID__", undefined);
    vi.stubGlobal("__GITHUB_APP_SLUG__", undefined);
    vi.stubGlobal("__GITHUB_APP_NAME__", undefined);
    vi.stubGlobal("__PROD__", false);

    const { getGitHubAppConfig } = await import("../src/config/github-app");
    expect(getGitHubAppConfig()).toEqual({
      clientId: "Iv1.devclientdev",
      slug: "github-pulls-show-reviewers-dev",
      name: "GitHub Pulls Show Reviewers (dev)",
    });
  });
});
