import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: ".",
  manifest: {
    name: "GitHub Pulls Show Reviewers",
    description: "Show requested reviewers and review state directly in GitHub pull request lists.",
    permissions: ["storage"],
    host_permissions: ["https://github.com/*", "https://api.github.com/*"],
  },
});
