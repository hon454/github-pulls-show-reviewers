import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  retries: process.env.CI ? 1 : 0,
  use: {
    headless: true,
    trace: "on-first-retry",
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
