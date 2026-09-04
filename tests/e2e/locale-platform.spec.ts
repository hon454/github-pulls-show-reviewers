import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";

const extension = path.resolve(".output/chrome-mv3");

test("ships exactly five complete Chrome-format catalogs and valid metadata", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/verify-packaged-locales.mjs",
      extension,
    ],
    { encoding: "utf8" },
  );
  expect(output).toContain("Verified five packaged locales");
});
const catalog = (locale: string) =>
  JSON.parse(
    readFileSync(
      path.join(extension, "_locales", locale, "messages.json"),
      "utf8",
    ),
  ) as Record<
    string,
    { message: string; placeholders?: Record<string, { content: string }> }
  >;
async function installedOptions(context: BrowserContext) {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const url = `chrome-extension://${new URL(worker.url()).host}/options.html`;
  // Retain #159's deterministic ownership of the first navigation.
  await expect
    .poll(() =>
      context
        .pages()
        .find((p) => p.url() === url)
        ?.url(),
    )
    .toBe(url);
  const page = context.pages().find((p) => p.url() === url)!;
  await expect(page.getByTestId("language-select")).toBeVisible();
  return { page, url };
}

test("observes native Chrome language outside runner emulation and retains preferences after process restart", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  const output = testInfo.outputPath("native-language.json");
  // A new Node process has no test-runner runBeforeCreateBrowserContext hook.
  execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "tests/helpers/native-locale-probe.ts",
      output,
    ],
    { timeout: 25000, stdio: "inherit" },
  );
  const evidence = JSON.parse(readFileSync(output, "utf8"));
  expect(evidence.execution).toBe("standalone-node-subprocess");
  expect(evidence.playwrightLocale).toBeNull();
  await testInfo.attach("native-language-evidence", {
    path: output,
    contentType: "application/json",
  });
});

test("cross-tab language switches retain device code, diagnostic input and a single pending auth request", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  const profile = await mkdtemp(path.join(os.tmpdir(), "ghpsr-device-locale-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  let releaseCode!: () => void;
  let releasePoll!: () => void;
  const codeReady = new Promise<void>((r) => {
    releaseCode = r;
  });
  const pollReady = new Promise<void>((r) => {
    releasePoll = r;
  });
  const requests: string[] = [];
  try {
    await context.route("https://**/*", async (route) => {
      requests.push(new URL(route.request().url()).pathname);
      if (route.request().url().endsWith("/login/device/code")) {
        await codeReady;
        await route.fulfill({
          json: {
            device_code: "fixture-device",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          },
        });
      } else if (route.request().url().endsWith("/login/oauth/access_token")) {
        await pollReady;
        await route.fulfill({ json: { error: "authorization_pending" } });
      } else await route.abort();
    });
    const { page, url } = await installedOptions(context);
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    const second = await context.newPage();
    await second.goto(url);
    await page
      .getByTestId("diagnostics-repo")
      .fill("owner/long-repository-input-preserved");
    await page.getByTestId("accounts-add").click();
    await expect.poll(() => requests.length).toBe(1);
    for (const locale of ["ko", "ja", "zh_CN", "zh_TW", "en"]) {
      await second.getByTestId("language-select").selectOption(locale);
      await expect(page.locator(".connection-panel")).toHaveText(
        catalog(locale).auth_requesting.message,
      );
      expect(requests).toEqual(["/login/device/code"]);
    }
    releaseCode();
    await expect(page.getByTestId("device-user-code")).toHaveText("ABCD-EFGH");
    await page.clock.runFor(1000);
    await expect.poll(() => requests.length).toBe(2);
    for (const locale of ["en", "ko", "ja", "zh_CN", "zh_TW"]) {
      const messages = catalog(locale);
      await second.getByTestId("language-select").selectOption(locale);
      await expect(page.locator("html")).toHaveAttribute(
        "lang",
        locale.replace("_", "-"),
      );
      await expect(page.getByTestId("device-user-code")).toHaveText(
        "ABCD-EFGH",
      );
      await expect(page.locator(".connection-panel [role=status]")).toHaveText(
        messages.auth_waiting.message,
      );
      await expect(
        page.getByRole("link", { name: messages.auth_open_github.message }),
      ).toHaveAttribute(
        "href",
        "https://github.com/login/device?user_code=ABCD-EFGH",
      );
      await expect(page.getByTestId("diagnostics-repo")).toHaveValue(
        "owner/long-repository-input-preserved",
      );
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const copy = page.getByRole("button", {
          name: messages.auth_copy.message,
          exact: true,
        });
        await copy.focus();
        await page.keyboard.press("Tab");
        const authorize = page.getByRole("link", {
          name: messages.auth_open_github.message,
        });
        await expect(authorize).toBeFocused();
        expect(
          await authorize.evaluate((el) => getComputedStyle(el).outlineStyle),
        ).not.toBe("none");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: testInfo.outputPath(`device-${locale}-${width}.png`),
          fullPage: true,
        });
      }
      expect(requests).toEqual([
        "/login/device/code",
        "/login/oauth/access_token",
      ]);
    }
    await page
      .getByRole("button", {
        name: catalog("zh_TW").auth_cancel.message,
        exact: true,
      })
      .click();
    releasePoll();
    await expect(page.locator(".connection-panel")).toHaveCount(0);
    await page.clock.runFor(10000);
    expect(requests).toEqual([
      "/login/device/code",
      "/login/oauth/access_token",
    ]);
    await testInfo.attach("auth-request-counts", {
      body: JSON.stringify({
        requests,
        switchesDuringInitiation: 5,
        switchesDuringPendingPoll: 5,
        extraRequests: 0,
        cancellationPreserved: true,
      }),
      contentType: "application/json",
    });
  } finally {
    releaseCode();
    releasePoll();
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
