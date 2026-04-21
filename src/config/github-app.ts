declare const __GITHUB_APP_CLIENT_ID__: string | undefined;
declare const __GITHUB_APP_SLUG__: string | undefined;
declare const __GITHUB_APP_NAME__: string | undefined;
declare const __PROD__: boolean;

export type GitHubAppConfig = {
  clientId: string;
  slug: string;
  name: string;
};

const DEV_DEFAULTS: GitHubAppConfig = {
  clientId: "Iv1.devclientdev",
  slug: "github-pulls-show-reviewers-dev",
  name: "GitHub Pulls Show Reviewers (dev)",
};

export function getGitHubAppConfig(): GitHubAppConfig {
  const rawClientId =
    typeof __GITHUB_APP_CLIENT_ID__ === "string" ? __GITHUB_APP_CLIENT_ID__ : "";
  const rawSlug =
    typeof __GITHUB_APP_SLUG__ === "string" ? __GITHUB_APP_SLUG__ : "";
  const rawName =
    typeof __GITHUB_APP_NAME__ === "string" ? __GITHUB_APP_NAME__ : "";

  const isProd = typeof __PROD__ === "boolean" ? __PROD__ : false;

  if (isProd) {
    if (!rawClientId) {
      throw new Error("WXT_GITHUB_APP_CLIENT_ID must be set for production builds.");
    }
    if (!rawSlug) {
      throw new Error("WXT_GITHUB_APP_SLUG must be set for production builds.");
    }
  }

  return {
    clientId: rawClientId || DEV_DEFAULTS.clientId,
    slug: rawSlug || DEV_DEFAULTS.slug,
    name: rawName || DEV_DEFAULTS.name,
  };
}

export function buildInstallAppUrl(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}
