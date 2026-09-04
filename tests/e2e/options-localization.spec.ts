import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";

const extensionPath = path.resolve(".output/chrome-mv3");

test("keeps options state across tabs and readable actions in five languages at 360px and desktop", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  const profile = await mkdtemp(
    path.join(os.tmpdir(), "ghpsr-options-locales-"),
  );
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    // Isolated fixture only: account access and external requests never leave the test.
    await context.route("https://**/*", (route) => route.abort());
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const url = `chrome-extension://${new URL(worker.url()).host}/options.html`;
    const first = await context.newPage();
    await first.goto(url);
    await first.evaluate(async () => {
      const storage = (
        globalThis as unknown as {
          chrome: { storage: { local: { set(items: object): Promise<void> } } };
        }
      ).chrome.storage.local;
      await storage.set({
        settings: { version: 4, accountIds: ["long-account"] },
        "account:profile:long-account": {
          id: "long-account",
          login: "long-account-identifier-for-layout-check",
          avatarUrl: null,
          createdAt: 1,
        },
        "account:auth:long-account": {
          token: "fixture-only-token",
          refreshToken: null,
          expiresAt: null,
          refreshTokenExpiresAt: null,
          invalidated: false,
          invalidatedReason: null,
        },
        "account:installations:long-account": {
          installations: [
            {
              id: 1,
              account: {
                login: "long-organization-identifier-for-layout-check",
                type: "Organization",
                avatarUrl: null,
              },
              repositorySelection: "all",
              repoFullNames: null,
            },
          ],
          installationsRefreshedAt: 1,
        },
      });
    });
    await first.reload();
    const second = await context.newPage();
    await second.goto(url);
    await first
      .getByTestId("diagnostics-repo")
      .fill("long-owner/repository-input-must-survive");
    for (const [language, heading] of [
      ["en", "GitHub accounts"],
      ["ko", "GitHub 계정"],
      ["ja", "GitHubアカウント"],
      ["zh_CN", "GitHub 账号"],
      ["zh_TW", "GitHub 帳號"],
    ]) {
      await first.getByTestId("language-select").selectOption(language);
      await expect(first.locator("#accounts-title")).toHaveText(heading);
      await expect(second.locator("#accounts-title")).toHaveText(heading);
      await expect(second.getByTestId("language-select")).toHaveValue(language);
      await expect(first.locator("html")).toHaveAttribute(
        "lang",
        language.replace("_", "-"),
      );
      await expect(first.getByTestId("diagnostics-repo")).toHaveValue(
        "long-owner/repository-input-must-survive",
      );
      for (const width of [360, 1280]) {
        await first.setViewportSize({ width, height: 900 });
        await expect(first.getByTestId("accounts-add")).toBeVisible();
        await expect(first.locator(".account-row .button")).toHaveCount(2);
        const dimensions = await first.evaluate(() => ({
          viewport: innerWidth,
          content: document.documentElement.scrollWidth,
        }));
        expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
        for (const action of await first
          .locator(
            ".account-row .button, #language-select, .add-account-button",
          )
          .all()) {
          const box = await action.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        }
        await first.screenshot({
          path: testInfo.outputPath(`options-${language}-${width}.png`),
          fullPage: true,
        });
      }
    }
    await second.reload();
    await expect(second.getByTestId("language-select")).toHaveValue("zh_TW");
    await second.getByTestId("language-select").selectOption("auto");
    await expect(first.getByTestId("language-select")).toHaveValue("auto");
    await expect(first.getByTestId("diagnostics-repo")).toHaveValue(
      "long-owner/repository-input-must-survive",
    );
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
