import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Locale } from "../../src/i18n";
function toLanguageTag(locale: Locale): string {
  return locale.replace("_", "-");
}
function createTranslator(locale: Locale) {
  const catalog = JSON.parse(
    readFileSync(
      path.resolve(`public/_locales/${locale}/messages.json`),
      "utf8",
    ),
  ) as Record<string, { message: string }>;
  return (key: string, values: Record<string, string> = {}): string =>
    catalog[key].message.replace(
      /\$([A-Z_]+)\$/g,
      (_, name: string) => values[name.toLowerCase()] ?? `$${name}$`,
    );
}
import { createPullListFixtureHtml } from "../helpers/pull-list-fixtures";

test("switches five reviewer locales during FIFO requests, preserves errors and banner dismissal at 360px", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  const profile = await mkdtemp(
    path.join(os.tmpdir(), "ghpsr-reviewer-locales-"),
  );
  const extension = path.resolve(".output/chrome-mv3");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    viewport: { width: 360, height: 800 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const releases: Array<() => void> = [];
  try {
    const pulls = ["42", "43", "44", "45", "46", "47", "48", "49"];
    const fixture = createPullListFixtureHtml(pulls).replace(
      "<body>",
      '<body><div class="pr-toolbar"></div>',
    );
    let metadataRequests = 0;
    let eventRequests = 0;
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    await context.route("https://**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "github.com" && url.pathname.endsWith("/pulls")) {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: fixture,
        });
      } else if (
        url.hostname === "api.github.com" &&
        url.pathname.endsWith("/pulls")
      ) {
        metadataRequests++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            pulls.map((number) => ({
              number: Number(number),
              user: { login: "author" },
              requested_reviewers: [{ login: "alice" }],
              requested_teams: [{ slug: "platform" }],
            })),
          ),
        });
      } else if (
        url.hostname === "api.github.com" &&
        /\/pulls\/\d+\/reviews$/.test(url.pathname)
      ) {
        const number = url.pathname.split("/").at(-2)!;
        started.push(number);
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        await route.fulfill({
          status: number === "49" ? 500 : 200,
          contentType: "application/json",
          body:
            number === "49"
              ? JSON.stringify({ message: "fixture unavailable" })
              : JSON.stringify([
                  {
                    state: "APPROVED",
                    submitted_at: "2026-09-01T00:00:00Z",
                    user: { login: "alice" },
                  },
                ]),
        });
      } else if (
        url.hostname === "api.github.com" &&
        /\/issues\/\d+\/events$/.test(url.pathname)
      ) {
        eventRequests++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              event: "review_requested",
              created_at: "2026-09-02T00:00:00Z",
              requested_reviewer: { login: "alice" },
            },
          ]),
        });
      } else await route.abort();
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const optionsUrl = `chrome-extension://${new URL(worker.url()).host}/options.html`;
    // Preserve #159: wait for and reuse the onInstalled options page.
    await expect
      .poll(() =>
        context
          .pages()
          .find((p) => p.url() === optionsUrl)
          ?.url(),
      )
      .toBe(optionsUrl);
    const options = context.pages().find((p) => p.url() === optionsUrl)!;
    await expect(options.getByTestId("language-select")).toBeVisible();
    const page = await context.newPage();
    await page.goto(
      "https://github.com/hon454/github-pulls-show-reviewers/pulls",
    );
    await expect.poll(() => started.length).toBe(4);
    const githubLang = await page.locator("html").getAttribute("lang");
    const originalTitle = await page
      .locator(".js-issue-row")
      .first()
      .locator('a[href*="/pull/"]')
      .first()
      .textContent();
    for (const locale of ["ko", "ja", "zh_CN", "zh_TW"] as Locale[]) {
      await options.getByTestId("language-select").selectOption(locale);
      await expect(page.locator(".ghpsr-status").first()).toHaveText(
        createTranslator(locale)("reviewers_loading"),
      );
      expect(started).toEqual(pulls.slice(0, 4));
      expect(metadataRequests).toBe(1);
    }
    for (let index = 0; index < pulls.length; index++) {
      releases.shift()!();
      await expect
        .poll(() => started.length)
        .toBe(Math.min(5 + index, pulls.length));
    }
    await expect(page.locator(".ghpsr-section-label")).toHaveCount(7);
    const banner = page.locator("[data-ghpsr-banner]");
    await expect(banner).toBeVisible();
    expect(started).toEqual(pulls);
    expect(peak).toBe(4);
    for (const locale of ["en", "ko", "ja", "zh_CN", "zh_TW"] as Locale[]) {
      const t = createTranslator(locale);
      await options.getByTestId("language-select").selectOption(locale);
      await expect(page.locator(".ghpsr-section-label").first()).toHaveText(
        t("reviewers_section"),
      );
      await expect(page.locator(".ghpsr-chip--team").first()).toHaveText(
        t("reviewers_team", { slug: "platform" }),
      );
      await expect(page.locator("a.ghpsr-avatar").first()).toHaveAttribute(
        "aria-label",
        t("reviewers_aria", {
          login: "alice",
          state: t("reviewers_approved_requested"),
        }),
      );
      await expect(page.locator("a.ghpsr-avatar").first()).toHaveAttribute(
        "title",
        t("reviewers_title", {
          login: "alice",
          state: t("reviewers_approved_requested"),
        }),
      );
      await expect(page.locator("#issue_49 .ghpsr-root")).toBeEmpty();
      await expect(page.locator(".ghpsr-root").first()).toHaveAttribute(
        "lang",
        toLanguageTag(locale),
      );
      await expect(banner).toContainText(t("banner_reviewers_unavailable"));
      await expect(
        banner.getByRole("button", { name: t("banner_dismiss") }),
      ).toBeVisible();
      await expect(
        banner.getByRole("link", { name: t("banner_reload") }),
      ).toHaveAttribute("href", page.url());
      // Language changes must leave host markup and request totals unchanged.
      expect(await page.locator("html").getAttribute("lang")).toBe(githubLang);
      expect(
        await page
          .locator(".js-issue-row")
          .first()
          .locator('a[href*="/pull/"]')
          .first()
          .textContent(),
      ).toBe(originalTitle);
      expect(started).toEqual(pulls);
      expect(metadataRequests).toBe(1);
      expect(eventRequests).toBe(7);
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        await page.locator("a.ghpsr-avatar").first().focus();
        await expect(page.locator("a.ghpsr-avatar").first()).toBeFocused();
        await page.screenshot({
          path: testInfo.outputPath(`reviewers-${locale}-${width}.png`),
          fullPage: true,
        });
        const bannerBounds = await banner.boundingBox();
        expect(bannerBounds!.x + bannerBounds!.width).toBeLessThanOrEqual(
          width,
        );
      }
    }
    await banner.getByRole("button").click();
    await options.getByTestId("language-select").selectOption("ko");
    await expect(page.locator(".ghpsr-root").first()).toHaveAttribute(
      "lang",
      "ko",
    );
    await expect(banner).toHaveCount(0);
    // Stress extension-owned mutations while every request is settled.
    await page.evaluate(() => {
      for (let i = 0; i < 100; i++) {
        document.querySelectorAll(".ghpsr-root").forEach((root) => {
          const node = document.createElement("span");
          node.textContent = `locale-${i}`;
          root.append(node);
          node.remove();
        });
      }
    });
    await options.getByTestId("language-select").selectOption("ja");
    await expect(page.locator(".ghpsr-root").first()).toHaveAttribute(
      "lang",
      "ja",
    );
    expect(started).toEqual(pulls);
    expect(metadataRequests).toBe(1);
    await testInfo.attach("request-counts", {
      body: JSON.stringify({
        metadataRequests,
        eventRequests,
        started,
        peak,
        screenshots: 10,
      }),
      contentType: "application/json",
    });
  } finally {
    releases.forEach((release) => release());
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
