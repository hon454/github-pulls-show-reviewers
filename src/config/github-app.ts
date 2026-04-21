declare const __GITHUB_APP_CLIENT_ID__: string | undefined;
declare const __GITHUB_APP_SLUG__: string | undefined;
declare const __GITHUB_APP_NAME__: string | undefined;
declare const __PROD__: boolean;

export type GitHubAppConfig = {
  clientId: string;
  slug: string;
  name: string;
};

export type GitHubAppConfigLookup =
  | { ok: true; config: GitHubAppConfig }
  | { ok: false; message: string };

const DEV_DEFAULTS: GitHubAppConfig = {
  clientId: "Iv1.devclientdev",
  slug: "github-pulls-show-reviewers-dev",
  name: "GitHub Pulls Show Reviewers (dev)",
};

export function getGitHubAppConfig(): GitHubAppConfig {
  const result = readGitHubAppConfig();
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.config;
}

export function readGitHubAppConfig(): GitHubAppConfigLookup {
  const rawClientId =
    typeof __GITHUB_APP_CLIENT_ID__ === "string" ? __GITHUB_APP_CLIENT_ID__ : "";
  const rawSlug =
    typeof __GITHUB_APP_SLUG__ === "string" ? __GITHUB_APP_SLUG__ : "";
  const rawName =
    typeof __GITHUB_APP_NAME__ === "string" ? __GITHUB_APP_NAME__ : "";

  const isProd = typeof __PROD__ === "boolean" ? __PROD__ : false;

  if (isProd) {
    const missing: string[] = [];
    if (!rawClientId) {
      missing.push("WXT_GITHUB_APP_CLIENT_ID");
    }
    if (!rawSlug) {
      missing.push("WXT_GITHUB_APP_SLUG");
    }
    if (missing.length > 0) {
      return {
        ok: false,
        message: `${missing.join(" and ")} must be set for production builds.`,
      };
    }
  }

  return {
    ok: true,
    config: {
      clientId: rawClientId || DEV_DEFAULTS.clientId,
      slug: rawSlug || DEV_DEFAULTS.slug,
      name: rawName || DEV_DEFAULTS.name,
    },
  };
}

export function buildInstallAppUrl(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}
