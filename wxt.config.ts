import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: ".",
  manifest: {
    name: "GitHub Pulls Show Reviewers",
    description: "Show requested reviewers and review state directly in GitHub pull request lists.",
    icons: {
      16: "/icon/16.png",
      32: "/icon/32.png",
      48: "/icon/48.png",
      128: "/icon/128.png",
    },
    permissions: ["storage"],
    host_permissions: ["https://github.com/*", "https://api.github.com/*"],
  },
});
