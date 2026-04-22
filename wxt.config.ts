import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: ".",
  vite: () => ({
    define: {
      __GITHUB_APP_CLIENT_ID__: JSON.stringify(
        process.env.WXT_GITHUB_APP_CLIENT_ID ?? "",
      ),
      __GITHUB_APP_SLUG__: JSON.stringify(
        process.env.WXT_GITHUB_APP_SLUG ?? "",
      ),
      __GITHUB_APP_NAME__: JSON.stringify(
        process.env.WXT_GITHUB_APP_NAME ?? "",
      ),
      __PROD__: JSON.stringify(process.env.NODE_ENV === "production"),
    },
  }),
  manifest: {
    name: "GitHub Pulls Show Reviewers",
    description:
      "Show requested reviewers and review state directly in GitHub pull request lists.",
    icons: {
      16: "/icon/16.png",
      32: "/icon/32.png",
      48: "/icon/48.png",
      128: "/icon/128.png",
    },
    permissions: ["storage"],
    host_permissions: ["https://github.com/*", "https://api.github.com/*"],
    action: {
      default_title: "GitHub Pulls Show Reviewers — Open options",
      default_icon: {
        16: "/icon/16.png",
        32: "/icon/32.png",
        48: "/icon/48.png",
        128: "/icon/128.png",
      },
    },
  },
});
