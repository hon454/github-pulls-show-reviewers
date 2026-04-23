import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    headless: true,
  },
  projects: [
    {
      name: "default",
      testIgnore: ["**/capture-cws-assets.spec.ts"],
    },
    {
      name: "capture",
      testMatch: ["**/capture-cws-assets.spec.ts"],
    },
  ],
});
