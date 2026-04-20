import { mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { chromium, expect, test } from "@playwright/test";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../..");
const extensionPath = path.join(projectRoot, ".output/chrome-mv3");
const fixturePath = path.join(projectRoot, "tests/fixtures/github-pulls.html");

test("renders reviewer chips from the extension on a GitHub pulls page", async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "ghpsr-playwright-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const serviceWorker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    expect(serviceWorker.url()).toContain("chrome-extension://");

    const fixtureHtml = await readFile(fixturePath, "utf8");

    await context.route("https://github.com/hon454/github-pulls-show-reviewers/pulls", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: fixtureHtml,
      });
    });

    await context.route(
      "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            user: { login: "hon454" },
            requested_reviewers: [{ login: "alice" }],
            requested_teams: [{ slug: "platform" }],
          }),
        });
      },
    );

    await context.route(
      "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              state: "APPROVED",
              submitted_at: "2026-04-20T12:00:00Z",
              user: { login: "bob" },
            },
          ]),
        });
      },
    );

    const page = await context.newPage();
    await page.goto("https://github.com/hon454/github-pulls-show-reviewers/pulls");

    await expect(page.locator(".ghpsr-root")).toContainText("Requested:");
    await expect(page.locator(".ghpsr-root")).toContainText("alice");
    await expect(page.locator(".ghpsr-root")).toContainText("@platform");
    await expect(page.locator(".ghpsr-root")).toContainText("Reviewed:");
    await expect(page.locator(".ghpsr-root")).toContainText("bob · approved");
  } finally {
    await context.close();
  }
});
