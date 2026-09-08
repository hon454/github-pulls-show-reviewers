import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";

const extensionPath = path.resolve(".output/chrome-mv3");

test("restores the add-account fallback after completion removes focused Copy", async ({
  browserName,
}) => {
  expect(browserName).toBe("chromium");
  const profile = await mkdtemp(path.join(os.tmpdir(), "ghpsr-focus-recovery-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  let markUserRequested!: () => void;
  let releaseUser!: () => void;
  const userRequested = new Promise<void>((resolve) => {
    markUserRequested = resolve;
  });
  const userResponse = new Promise<void>((resolve) => {
    releaseUser = resolve;
  });
  try {
    await context.route("https://**/*", async (route) => {
      const endpoint = new URL(route.request().url()).pathname;
      if (endpoint === "/login/device/code") {
        await route.fulfill({
          json: {
            device_code: "fixture-device",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          },
        });
      } else if (endpoint === "/login/oauth/access_token") {
        await route.fulfill({
          json: {
            access_token: "fixture-access",
            refresh_token: "fixture-refresh",
            token_type: "bearer",
            expires_in: 28_800,
            refresh_token_expires_in: 15_552_000,
          },
        });
      } else if (endpoint === "/user") {
        markUserRequested();
        await userResponse;
        await route.fulfill({ json: { login: "octocat", avatar_url: null } });
      } else if (endpoint === "/user/installations") {
        await route.fulfill({ json: { total_count: 0, installations: [] } });
      } else {
        await route.abort();
      }
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const url = `chrome-extension://${new URL(worker.url()).host}/options.html`;
    await expect
      .poll(() => context.pages().find((page) => page.url() === url)?.url())
      .toBe(url);
    const page = context.pages().find((item) => item.url() === url)!;
    await page.getByTestId("accounts-add").click();
    await expect(page.getByTestId("device-user-code")).toBeVisible();
    await page.getByRole("button", { name: "Copy", exact: true }).focus();
    await userRequested;
    await expect(page.locator("body")).toBeFocused();
    releaseUser();
    await expect(page.getByTestId("accounts-add")).toBeVisible();
    await expect(page.getByTestId("accounts-add")).toBeFocused();
  } finally {
    releaseUser?.();
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
