import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type TestInfo,
} from "@playwright/test";
import { createPullListFixtureHtml } from "../helpers/pull-list-fixtures";

const numbers = ["42", "43", "44", "45", "46", "47", "48", "49"];
const pageUrl = "https://github.com/hon454/github-pulls-show-reviewers/pulls";
const fixture = createPullListFixtureHtml(numbers).replace(
  "<body>",
  '<body><div class="pr-toolbar"></div>',
);
const metadata = numbers.map((number) => ({
  number: Number(number),
  user: { login: "author" },
  requested_reviewers: [],
  requested_teams: [],
}));
const reviews = (login: string) => [
  {
    state: "APPROVED",
    submitted_at: "2026-09-01T00:00:00Z",
    user: { login },
  },
];

async function withExtension(
  run: (context: BrowserContext) => Promise<void>,
  testInfo: TestInfo,
) {
  const extension = path.resolve(".output/chrome-mv3");
  const profile = await mkdtemp(path.resolve(".output/deadline-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  try {
    await testInfo.attach("environment", {
      body: JSON.stringify({
        node: process.version,
        browser: context.browser()?.version(),
        extension,
        productionDeadlines: true,
      }),
      contentType: "application/json",
    });
    await run(context);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

test("packaged deadlines retain stale chips, free four slots and reject late replies after navigation", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(90_000);
  await withExtension(async (context) => {
    let phase: "warm" | "stall" | "next" = "warm";
    let metadataCount = 0;
    const started: Array<{ number: string; at: number }> = [];
    const releases: Array<() => void> = [];
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
        metadataCount++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(metadata),
        });
      } else if (
        url.hostname === "api.github.com" &&
        /\/pulls\/\d+\/reviews$/.test(url.pathname)
      ) {
        const number = url.pathname.split("/").at(-2)!;
        const requestedPhase = phase;
        if (requestedPhase === "stall") {
          started.push({ number, at: Date.now() });
          if (started.length <= 4) {
            await new Promise<void>((resolve) => releases.push(resolve));
            // The transport is deliberately late; Chromium may have canceled it.
            await route
              .fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(reviews("late-reviewer")),
              })
              .catch(() => undefined);
            return;
          }
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            reviews(requestedPhase === "next" ? "next-reviewer" : "bob"),
          ),
        });
      } else await route.abort();
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const optionsUrl = `chrome-extension://${new URL(worker.url()).host}/options.html`;
    await expect
      .poll(() =>
        context
          .pages()
          .find((page) => page.url() === optionsUrl)
          ?.url(),
      )
      .toBe(optionsUrl);
    const options = context.pages().find((page) => page.url() === optionsUrl)!;
    const page = await context.newPage();
    await page.goto(pageUrl);
    await expect(page.locator('a[title*="@bob"]')).toHaveCount(8);
    phase = "stall";
    await page.evaluate(() =>
      document.dispatchEvent(new Event("turbo:render", { bubbles: true })),
    );
    await expect.poll(() => started.length).toBe(4);
    const metadataAtStart = metadataCount;
    await options.getByTestId("language-select").selectOption("ko");
    const showNames = options.getByTestId("prefs-show-reviewer-name");
    await expect(showNames).not.toBeChecked();
    await showNames.click();
    await expect(showNames).toBeChecked();
    await expect(showNames).toBeEnabled();
    await expect(page.locator(".ghpsr-root").first()).toHaveAttribute(
      "lang",
      "ko",
    );
    await expect(page.locator('a[title*="@bob"]')).toHaveCount(8);
    expect(started.map(({ number }) => number)).toEqual(numbers.slice(0, 4));
    expect(metadataCount).toBe(metadataAtStart);
    await expect.poll(() => started.length, { timeout: 40_000 }).toBe(8);
    // Production 30s operation deadlines, without a test-only duration override.
    const nextBatchAfterMs = started[4].at - started[0].at;
    expect(nextBatchAfterMs).toBeGreaterThanOrEqual(29_000);
    expect(started.map(({ number }) => number)).toEqual(numbers);
    await expect(page.locator("[data-ghpsr-banner]")).toHaveCount(1);
    await expect(page.locator("[data-ghpsr-banner] a")).toHaveAttribute(
      "href",
      page.url(),
    );
    await expect(page.locator('a[title*="@bob"]')).toHaveCount(8);
    await expect(page.locator(".ghpsr-status")).toHaveCount(0);
    expect(metadataCount).toBe(metadataAtStart);
    phase = "next";
    await page.evaluate(() => {
      history.pushState({}, "", "?q=is%3Apr+is%3Aopen");
      document.dispatchEvent(new Event("turbo:render", { bubbles: true }));
    });
    await expect(page.locator('a[title*="@next-reviewer"]')).toHaveCount(8);
    for (const release of releases) release();
    await options.getByTestId("language-select").selectOption("en");
    await expect(page.locator(".ghpsr-root").first()).toHaveAttribute(
      "lang",
      "en",
    );
    await expect(page.locator('a[title*="@next-reviewer"]')).toHaveCount(8);
    await expect(page.locator('a[title*="@late-reviewer"]')).toHaveCount(0);
    await expect(page.locator("[data-ghpsr-banner]")).toHaveCount(0);
    await testInfo.attach("deadline-outcomes", {
      body: JSON.stringify({
        started,
        nextBatchAfterMs,
        metadataAtStart,
        staleChips: 8,
        lateRepliesIgnored: 4,
      }),
      contentType: "application/json",
    });
  }, testInfo);
});

test("packaged shared metadata timeout clears all loading rows without row fallback", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(60_000);
  await withExtension(async (context) => {
    let metadataCount = 0;
    let summaryCount = 0;
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
        metadataCount++;
        // Leave the intercepted request without a response until context cleanup.
      } else if (url.hostname === "api.github.com") {
        summaryCount++;
        await route.abort();
      } else await route.abort();
    });
    const page = await context.newPage();
    await page.goto(pageUrl);
    await expect(page.locator(".ghpsr-status")).toHaveCount(8);
    await expect(page.locator("[data-ghpsr-banner]")).toHaveCount(1, {
      timeout: 40_000,
    });
    await expect(page.locator("[data-ghpsr-banner]")).toContainText(
      "Reviewer data is temporarily unavailable",
    );
    await expect(page.locator(".ghpsr-status")).toHaveCount(0);
    expect(metadataCount).toBe(1);
    expect(summaryCount).toBe(0);
    await testInfo.attach("shared-timeout-counts", {
      body: JSON.stringify({ metadataCount, summaryCount, terminalRows: 8 }),
      contentType: "application/json",
    });
  }, testInfo);
});

test("packaged optional timeout preserves confirmed partial evidence and renders remaining requests unverified", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(40_000);
  await withExtension(async (context) => {
    const requested = [{ login: "alice" }, { login: "bob" }];
    const counts = { metadata: 0, reviews: 0, events: 0 };
    let eventsStartedAt = 0;
    let releaseLatePage!: () => void;
    await context.route("https://**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "github.com" && url.pathname.endsWith("/pulls")) {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: createPullListFixtureHtml(["42"]),
        });
      } else if (
        url.hostname === "api.github.com" &&
        url.pathname.endsWith("/pulls")
      ) {
        counts.metadata++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              ...metadata[0],
              requested_reviewers: requested,
            },
          ]),
        });
      } else if (
        url.hostname === "api.github.com" &&
        url.pathname.endsWith("/reviews")
      ) {
        counts.reviews++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            requested.flatMap(({ login }) => reviews(login)),
          ),
        });
      } else if (
        url.hostname === "api.github.com" &&
        url.pathname.endsWith("/events")
      ) {
        counts.events++;
        if (url.searchParams.get("page") === "2") {
          await new Promise<void>((resolve) => {
            releaseLatePage = resolve;
          });
          await route
            .fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify([
                {
                  event: "review_requested",
                  created_at: "2026-09-03T00:00:00Z",
                  requested_reviewer: { login: "bob" },
                },
              ]),
            })
            .catch(() => undefined);
          return;
        }
        eventsStartedAt = Date.now();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: {
            Link: `<${url.origin}${url.pathname}?page=2>; rel="next"`,
          },
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
    await expect
      .poll(() =>
        context
          .pages()
          .find((page) => page.url() === optionsUrl)
          ?.url(),
      )
      .toBe(optionsUrl);
    const options = context.pages().find((page) => page.url() === optionsUrl)!;
    await options.getByTestId("language-select").selectOption("en");
    const page = await context.newPage();
    await page.goto(pageUrl);
    await expect.poll(() => counts.events).toBe(2);
    await expect(page.locator(".ghpsr-status")).toHaveCount(1);
    const showNames = options.getByTestId("prefs-show-reviewer-name");
    // This controlled input reflects the acknowledged background snapshot.
    await expect(showNames).not.toBeChecked();
    await showNames.click();
    await expect(showNames).toBeChecked();
    await expect(showNames).toBeEnabled();
    const alice = page.locator('a[title*="@alice"]');
    const bob = page.locator('a[title*="@bob"]');
    await expect(bob).toHaveAttribute(
      "title",
      /previous review: approved.*re-request timing unavailable/,
      { timeout: 15_000 },
    );
    const elapsedMs = Date.now() - eventsStartedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(9_000);
    await expect(alice).toHaveAttribute(
      "title",
      /approved \(still requested\)/,
    );
    await expect(alice.locator(".ghpsr-badge--refresh")).toHaveCount(1);
    await expect(bob.locator(".ghpsr-badge--refresh")).toHaveCount(0);
    await expect(bob.locator(".ghpsr-avatar--border-requested")).toHaveCount(1);
    await expect(bob).toHaveAttribute("href", /review-requested%3Abob/);
    await expect(page.locator(".ghpsr-status")).toHaveCount(0);
    await expect(page.locator("[data-ghpsr-banner]")).toHaveCount(0);
    releaseLatePage();
    await showNames.click();
    await expect(showNames).not.toBeChecked();
    await expect(bob).toHaveClass(/ghpsr-avatar--border-requested/);
    await expect(bob).toHaveAttribute("title", /re-request timing unavailable/);
    await expect(bob.locator(".ghpsr-badge--refresh")).toHaveCount(0);
    await expect(alice.locator(".ghpsr-badge--refresh")).toHaveCount(1);
    expect(counts).toEqual({ metadata: 1, reviews: 1, events: 2 });
    await page.screenshot({
      path: testInfo.outputPath("optional-partial-evidence.png"),
      fullPage: true,
    });
    await testInfo.attach("optional-timeout-outcomes", {
      body: JSON.stringify({
        counts,
        elapsedMs,
        confirmed: ["alice"],
        unverified: ["bob"],
        lateEvidenceIgnored: true,
      }),
      contentType: "application/json",
    });
  }, testInfo);
});
