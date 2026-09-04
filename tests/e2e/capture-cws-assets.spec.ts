import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, type Page, test } from "@playwright/test";

import {
  SUPPORTED_LOCALES,
  toLanguageTag,
  type Locale,
} from "../../src/i18n/locale";
import {
  assetPaths,
  fileHashes,
  sourcePaths,
} from "../../scripts/verify-cws-assets.mjs";

// Read canonical catalog text directly: Node's Playwright loader does not bundle
// JSON imports like WXT does. No independent expected translations live here.
function messages(locale: Locale): Record<string, { message: string }> {
  return JSON.parse(
    readFileSync(
      path.resolve(`public/_locales/${locale}/messages.json`),
      "utf8",
    ),
  );
}
let chromiumVersion = "";
const capturedLocales: Locale[] = [];

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../..");
const extensionPath = path.join(projectRoot, ".output/chrome-mv3");
const outputDir = path.join(projectRoot, "docs/chrome-web-store-assets");
const pullsFixturePath = path.join(
  projectRoot,
  "tests/fixtures/github-pulls.html",
);
const storeScreenshotSize = { width: 1280, height: 800 } as const;
const storeScreenshotFiles = [
  "01-pr-list-before-after.png",
  "02-pr-list-avatar-state-showcase.png",
  "03-options-repository-check.png",
] as const;

const screenshotRepo = {
  owner: "hon454",
  repo: "github-pulls-show-reviewers",
} as const;
const screenshotRepoFullName = `${screenshotRepo.owner}/${screenshotRepo.repo}`;
const screenshotPullsUrl = `https://github.com/${screenshotRepoFullName}/pulls`;
const fixturePrimaryTitle =
  "feat(canvas): add alignment handles to selection overlay";

type ReviewPayload = {
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  submitted_at: string;
  user: { login: string; avatar_url: string };
};

type ReviewRequestEventPayload = {
  event: "review_requested";
  created_at: string;
  requested_reviewer: { login: string; avatar_url: string };
};

type PullScene = {
  pullNumber: string;
  summary: {
    user: { login: string };
    requested_reviewers: Array<{ login: string; avatar_url: string }>;
    requested_teams: Array<{ slug: string }>;
  };
  reviews: ReviewPayload[];
  reviewRequestEvents?: ReviewRequestEventPayload[];
  expectedLogins: string[];
  expectedTeamSlug?: string;
  expectedBadgeClasses: string[];
};

const avatarBase = "https://avatars.example.test/reviewers";
const avatarUrl = (login: string): string => `${avatarBase}/${login}.svg`;

const avatarStateScenes: PullScene[] = [
  {
    pullNumber: "200",
    summary: {
      user: { login: "mira" },
      requested_reviewers: [{ login: "ava", avatar_url: avatarUrl("ava") }],
      requested_teams: [{ slug: "design-systems" }],
    },
    reviews: [
      {
        state: "APPROVED",
        submitted_at: "2026-04-20T12:00:00Z",
        user: { login: "ben", avatar_url: avatarUrl("ben") },
      },
    ],
    expectedLogins: ["ava", "ben"],
    expectedTeamSlug: "design-systems",
    expectedBadgeClasses: ["ghpsr-badge--approved"],
  },
  {
    pullNumber: "199",
    summary: {
      user: { login: "mira" },
      requested_reviewers: [{ login: "mona", avatar_url: avatarUrl("mona") }],
      requested_teams: [],
    },
    reviews: [],
    expectedLogins: ["mona"],
    expectedBadgeClasses: [],
  },
  {
    pullNumber: "198",
    summary: {
      user: { login: "mira" },
      requested_reviewers: [],
      requested_teams: [],
    },
    reviews: [
      {
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-04-20T12:05:00Z",
        user: { login: "kian", avatar_url: avatarUrl("kian") },
      },
    ],
    expectedLogins: ["kian"],
    expectedBadgeClasses: ["ghpsr-badge--changes-requested"],
  },
  {
    pullNumber: "197",
    summary: {
      user: { login: "soren" },
      requested_reviewers: [{ login: "jules", avatar_url: avatarUrl("jules") }],
      requested_teams: [],
    },
    reviews: [
      {
        state: "APPROVED",
        submitted_at: "2026-04-20T12:10:00Z",
        user: { login: "jules", avatar_url: avatarUrl("jules") },
      },
      {
        state: "COMMENTED",
        submitted_at: "2026-04-20T12:15:00Z",
        user: { login: "riley", avatar_url: avatarUrl("riley") },
      },
    ],
    reviewRequestEvents: [
      {
        event: "review_requested",
        created_at: "2026-04-20T12:12:00Z",
        requested_reviewer: { login: "jules", avatar_url: avatarUrl("jules") },
      },
    ],
    expectedLogins: ["jules", "riley"],
    expectedBadgeClasses: ["ghpsr-badge--refresh", "ghpsr-badge--commented"],
  },
  {
    pullNumber: "192",
    summary: {
      user: { login: "mira" },
      requested_reviewers: [{ login: "nara", avatar_url: avatarUrl("nara") }],
      requested_teams: [],
    },
    reviews: [
      {
        state: "DISMISSED",
        submitted_at: "2026-04-20T12:20:00Z",
        user: { login: "ori", avatar_url: avatarUrl("ori") },
      },
    ],
    expectedLogins: ["nara", "ori"],
    expectedBadgeClasses: ["ghpsr-badge--dismissed"],
  },
  {
    pullNumber: "187",
    summary: {
      user: { login: "devon" },
      requested_reviewers: [],
      requested_teams: [],
    },
    reviews: [
      {
        state: "APPROVED",
        submitted_at: "2026-04-20T12:25:00Z",
        user: { login: "tess", avatar_url: avatarUrl("tess") },
      },
    ],
    expectedLogins: ["tess"],
    expectedBadgeClasses: ["ghpsr-badge--approved"],
  },
  {
    pullNumber: "186",
    summary: {
      user: { login: "devon" },
      requested_reviewers: [{ login: "sol", avatar_url: avatarUrl("sol") }],
      requested_teams: [],
    },
    reviews: [],
    expectedLogins: ["sol"],
    expectedBadgeClasses: [],
  },
  {
    pullNumber: "185",
    summary: {
      user: { login: "devon" },
      requested_reviewers: [],
      requested_teams: [],
    },
    reviews: [
      {
        state: "COMMENTED",
        submitted_at: "2026-04-20T12:30:00Z",
        user: { login: "park", avatar_url: avatarUrl("park") },
      },
    ],
    expectedLogins: ["park"],
    expectedBadgeClasses: ["ghpsr-badge--commented"],
  },
];

test.describe.configure({ mode: "serial" });

for (const locale of SUPPORTED_LOCALES) {
  test(`capture Chrome Web Store assets: ${locale}`, async () => {
    const localeDir = path.join(outputDir, locale === "en" ? "" : locale);
    await mkdir(localeDir, { recursive: true });
    await withExtensionContext(async (context, extensionId) => {
      // All external traffic is blocked unless explicitly fulfilled by a fixture.
      await context.route("https://**/*", (route) => route.abort());
      await routePullsFixture(context);
      await routeSyntheticAvatars(context);
      const optionsUrl = `chrome-extension://${extensionId}/options.html`;
      // Let onInstalled finish its owned navigation before manipulating options.
      await expect
        .poll(() =>
          context
            .pages()
            .find((page) => page.url() === optionsUrl)
            ?.url(),
        )
        .toBe(optionsUrl);
      const options = context
        .pages()
        .find((page) => page.url() === optionsUrl)!;
      await expect(options.getByTestId("language-select")).toBeVisible();
      await options.getByTestId("language-select").selectOption(locale);
      await expect(options.locator("html")).toHaveAttribute(
        "lang",
        toLanguageTag(locale),
      );
      await captureBeforeAfterScreenshot(context, locale, localeDir);
      await captureAvatarStateShowcase(context, locale, localeDir);
      await captureOptionsScreenshot(context, extensionId, locale, localeDir);
      await assertStoreScreenshotFiles(localeDir);
      capturedLocales.push(locale);
    });
  });
}

test("record complete capture provenance", async () => {
  expect(capturedLocales).toEqual([...SUPPORTED_LOCALES]);
  expect(chromiumVersion).not.toBe("");
  await writeFile(
    path.join(outputDir, "capture-manifest.json"),
    JSON.stringify(
      {
        build:
          "TESTING GitHub App; synthetic fixtures; not production-config evidence",
        rendering: {
          chromium: chromiumVersion,
          platform: process.platform,
          arch: process.arch,
          fonts: "host system fonts",
          viewport: storeScreenshotSize,
          deviceScaleFactor: 1,
        },
        sources: fileHashes(sourcePaths),
        images: fileHashes(assetPaths),
      },
      null,
      2,
    ) + "\n",
  );
});

async function withExtensionContext(
  run: (
    context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
    extensionId: string,
  ) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "ghpsr-cws-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    viewport: storeScreenshotSize,
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    expect(serviceWorker.url()).toContain("chrome-extension://");
    const extensionId = new URL(serviceWorker.url()).host;
    chromiumVersion = context.browser()!.version();
    await run(context, extensionId);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

async function withPlainContext(
  run: (
    context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  ) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "ghpsr-cws-plain-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    viewport: storeScreenshotSize,
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
  });

  try {
    await context.route("https://**/*", (route) => route.abort());
    await run(context);
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

async function routePullsFixture(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
): Promise<void> {
  const fixtureHtml = await readFile(pullsFixturePath, "utf8");
  await context.route(screenshotPullsUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: fixtureHtml,
    });
  });
}

async function routeSyntheticAvatars(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
): Promise<void> {
  await context.route(`${avatarBase}/*.svg`, async (route) => {
    const fileName =
      new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const login = fileName.replace(/\.svg$/, "") || "reviewer";
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: buildAvatarSvg(login),
    });
  });
}

function buildAvatarSvg(login: string): string {
  const hue = hashLogin(login) % 360;
  const initials = login
    .split("-")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="hsl(${hue} 72% 64%)"/><stop offset="1" stop-color="hsl(${(hue + 48) % 360} 68% 48%)"/></linearGradient></defs><rect width="48" height="48" rx="24" fill="url(#g)"/><text x="24" y="29" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#fff">${initials}</text></svg>`;
}

function hashLogin(login: string): number {
  return [...login].reduce((hash, char) => hash + char.charCodeAt(0), 0);
}

async function routeReviewerScenes(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  scenes: PullScene[],
): Promise<() => Promise<void>> {
  const routeUrls: string[] = [];

  for (const scene of scenes) {
    const pullRoute = `https://api.github.com/repos/${screenshotRepoFullName}/pulls/${scene.pullNumber}`;
    const reviewsRoute = `${pullRoute}/reviews**`;
    const eventsRoute = `https://api.github.com/repos/${screenshotRepoFullName}/issues/${scene.pullNumber}/events**`;
    routeUrls.push(pullRoute, reviewsRoute, eventsRoute);

    await context.route(pullRoute, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scene.summary),
      });
    });

    await context.route(reviewsRoute, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scene.reviews),
      });
    });

    await context.route(eventsRoute, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scene.reviewRequestEvents ?? []),
      });
    });
  }

  return async () => {
    for (const routeUrl of routeUrls) {
      await context.unroute(routeUrl);
    }
  };
}

async function assertReviewerScenes(
  page: Page,
  scenes: PullScene[],
  locale: Locale,
): Promise<void> {
  const catalog = messages(locale);
  const root = page.locator(".ghpsr-root");
  await expect(
    root.filter({ hasText: catalog.reviewers_section.message }),
  ).toHaveCount(scenes.length);

  for (const scene of scenes) {
    for (const login of scene.expectedLogins) {
      await expect(
        root.locator(`a.ghpsr-avatar[title*="@${login}"]`),
      ).toHaveCount(1);
    }
    for (const badgeClass of scene.expectedBadgeClasses) {
      expect(
        await root.locator(`.${badgeClass}`).count(),
        `${badgeClass} should render in the screenshot fixture`,
      ).toBeGreaterThan(0);
    }
    if (scene.expectedTeamSlug != null) {
      await expect(
        root.filter({
          hasText: catalog.reviewers_team.message.replace(
            "$SLUG$",
            scene.expectedTeamSlug,
          ),
        }),
      ).toHaveCount(1);
    }
  }
}

async function assertFixtureCopy(page: Page): Promise<void> {
  await expect(page.locator(".repo")).toContainText(screenshotRepo.owner);
  await expect(page.locator(".repo")).toContainText(screenshotRepo.repo);
  await expect(
    page.getByRole("link", { name: fixturePrimaryTitle }),
  ).toBeVisible();
  await expect(page.locator(".floating-help")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("CINEV");
  await expect(page.locator("body")).not.toContainText("shotloom");
}

async function stabilizePullListForScreenshot(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      /* Fixture framing only: keep all eight rows inside the 800px canvas. */
      .topbar { height: 70px; }
      .tabs, .tab { height: 44px; }
      .content { padding-top: 16px; padding-bottom: 20px; }
      .js-issue-row { padding-top: 8px; padding-bottom: 8px; }
      .d-none.d-md-inline-flex,
      [class*="ListItem-module__ListItemMetadataRow"] {
        display: inline-flex !important;
        visibility: visible !important;
      }
      .ghpsr-root {
        display: inline-flex !important;
      }
    `,
  });
}

async function captureMockedBeforeScreenshot(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  filePath: string,
): Promise<void> {
  const page = await context.newPage();
  try {
    await routePullsFixture(context);
    await page.goto(screenshotPullsUrl);
    await assertFixtureCopy(page);
    await expect(page.locator(".ghpsr-root")).toHaveCount(0);
    await stabilizePullListForScreenshot(page);
    for (const row of await page.locator(".js-issue-row").all()) {
      const box = await row.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        storeScreenshotSize.height,
      );
    }
    await readyForScreenshot(page);
    await page.screenshot({ path: filePath, animations: "disabled" });
  } finally {
    await page.close();
  }
}

async function captureMockedAfterScreenshot(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  scenes: PullScene[],
  filePath: string,
  locale: Locale,
): Promise<void> {
  const unrouteReviewerScenes = await routeReviewerScenes(context, scenes);
  const page = await context.newPage();
  try {
    await page.goto(screenshotPullsUrl);
    await assertFixtureCopy(page);
    await assertReviewerScenes(page, scenes, locale);
    await stabilizePullListForScreenshot(page);
    for (const row of await page.locator(".js-issue-row").all()) {
      const box = await row.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        storeScreenshotSize.height,
      );
    }
    await readyForScreenshot(page);
    await page.screenshot({ path: filePath, animations: "disabled" });
  } finally {
    await page.close();
    await unrouteReviewerScenes();
  }
}

async function captureBeforeAfterScreenshot(
  extensionContext: Awaited<
    ReturnType<typeof chromium.launchPersistentContext>
  >,
  locale: Locale,
  localeDir: string,
): Promise<void> {
  const beforePath = path.join(localeDir, "01-pr-list-before.tmp.png");
  const afterPath = path.join(localeDir, "01-pr-list-after.tmp.png");
  const combinedPath = path.join(localeDir, "01-pr-list-before-after.png");

  await withPlainContext(async (plainContext) => {
    await captureMockedBeforeScreenshot(plainContext, beforePath);
  });

  await captureMockedAfterScreenshot(
    extensionContext,
    avatarStateScenes,
    afterPath,
    locale,
  );

  const composer = await extensionContext.newPage();
  try {
    const beforeData = (await readFile(beforePath)).toString("base64");
    const afterData = (await readFile(afterPath)).toString("base64");
    await composer.setViewportSize(storeScreenshotSize);
    await composer.setContent(`
      <!doctype html>
      <html lang="${toLanguageTag(locale)}">
        <head>
          <style>
            body {
              margin: 0;
              background: #0d1117;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            .frame {
              width: ${storeScreenshotSize.width}px;
              height: ${storeScreenshotSize.height}px;
              box-sizing: border-box;
              padding: 24px;
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 18px;
            }
            .panel {
              height: ${storeScreenshotSize.height - 48}px;
              overflow: hidden;
              border: 1px solid #30363d;
              border-radius: 10px;
              background: #010409;
              box-shadow: 0 18px 45px rgba(0, 0, 0, 0.35);
            }
            .label {
              height: 48px;
              display: flex;
              align-items: center;
              padding: 0 16px;
              border-bottom: 1px solid #30363d;
              color: #e6edf3;
              font-size: 15px;
              font-weight: 700;
            }
            img {
              display: block;
              width: 125%;
              transform-origin: top left;
            }
          </style>
        </head>
        <body>
          <div class="frame">
            <section class="panel">
              <div class="label" data-caption="before"></div>
              <img alt="" src="data:image/png;base64,${beforeData}">
            </section>
            <section class="panel">
              <div class="label" data-caption="after"></div>
              <img alt="" src="data:image/png;base64,${afterData}">
            </section>
          </div>
        </body>
      </html>
    `);
    const copy = await readFile(
      path.join(projectRoot, `docs/chrome-web-store-locales/${locale}.md`),
      "utf8",
    );
    for (const caption of ["before", "after"] as const) {
      const text = copy.match(
        new RegExp(`<!-- capture-${caption}: (.+) -->`),
      )?.[1];
      expect(text, `${locale}: reviewed ${caption} caption`).toBeTruthy();
      await composer
        .locator(`[data-caption="${caption}"]`)
        .evaluate((element, value) => {
          element.textContent = value;
        }, text!);
    }
    await readyForScreenshot(composer);
    for (const label of await composer.locator(".label").all()) {
      expect(
        await label.evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth &&
            element.scrollHeight <= element.clientHeight,
        ),
      ).toBe(true);
    }
    await composer.screenshot({ path: combinedPath, animations: "disabled" });
  } finally {
    await composer.close();
    await rm(beforePath, { force: true });
    await rm(afterPath, { force: true });
  }
}

async function assertStoreScreenshotFiles(localeDir: string): Promise<void> {
  expect(storeScreenshotFiles.length).toBeGreaterThanOrEqual(1);
  expect(storeScreenshotFiles.length).toBeLessThanOrEqual(5);

  for (const fileName of storeScreenshotFiles) {
    const png = await readFile(path.join(localeDir, fileName));
    expect(png.toString("ascii", 1, 4)).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(storeScreenshotSize.width);
    expect(png.readUInt32BE(20)).toBe(storeScreenshotSize.height);
    expect(png.readUInt8(24)).toBe(8);
    expect(png.readUInt8(25)).toBe(2);
  }
}

async function captureAvatarStateShowcase(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  locale: Locale,
  localeDir: string,
): Promise<void> {
  await captureMockedAfterScreenshot(
    context,
    avatarStateScenes,
    path.join(localeDir, "02-pr-list-avatar-state-showcase.png"),
    locale,
  );
}

async function captureOptionsScreenshot(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  extensionId: string,
  locale: Locale,
  localeDir: string,
): Promise<void> {
  await setPreference(context, extensionId, "showReviewerName", true);

  await context.route(
    `https://api.github.com/repos/${screenshotRepoFullName}/pulls?per_page=1&state=all`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ number: 42 }]),
      });
    },
  );

  await context.route(
    `https://api.github.com/repos/${screenshotRepoFullName}/pulls/42`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { login: "mira" },
          requested_reviewers: [{ login: "ava", avatar_url: avatarUrl("ava") }],
          requested_teams: [{ slug: "design-systems" }],
        }),
      });
    },
  );

  await context.route(
    `https://api.github.com/repos/${screenshotRepoFullName}/pulls/42/reviews**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            state: "APPROVED",
            submitted_at: "2026-04-20T09:00:00Z",
            user: { login: "ben", avatar_url: avatarUrl("ben") },
          },
        ]),
      });
    },
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.getByTestId("prefs-show-reviewer-name")).toBeChecked();
  await page.getByTestId("diagnostics-repo").fill(screenshotRepoFullName);
  await page.getByTestId("diagnostics-no-token").click();
  await expect(page.getByTestId("diagnostics-status")).toHaveClass(
    /inline-status--success/,
  );
  await expect(page.locator("html")).toHaveAttribute(
    "lang",
    toLanguageTag(locale),
  );
  await expect(page.getByTestId("diagnostics-no-token")).toHaveText(
    messages(locale).diagnostics_check_no_token.message,
  );
  await readyForScreenshot(page);
  // Compose unmodified sections of the real options page so settings and the
  // completed diagnostic fit together without cropping scroll-boundary text.
  const crops: Record<string, string> = {};
  for (const [name, selector] of Object.entries({
    language: ".language-settings",
    display: '[aria-labelledby="display-title"]',
    diagnostics: '[aria-labelledby="diagnostics-title"]',
  })) {
    crops[name] = (
      await page.locator(selector).screenshot({ animations: "disabled" })
    ).toString("base64");
  }
  const composer = await context.newPage();
  try {
    await composer.setContent(`<!doctype html><html lang="${toLanguageTag(locale)}"><head><style>
      * { box-sizing: border-box; }
      body { margin: 0; background: #0d1117; color: #f0f6fc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      h1 { margin: 0; padding: 30px 36px; font-size: 24px; line-height: 1.4; }
      .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; padding: 0 28px; }
      .panel { padding: 16px; border: 1px solid #30363d; border-radius: 10px; background: #0d1117; }
      img { width: 100%; height: auto; display: block; }
      .language { margin-bottom: 24px; }
    </style></head><body><h1></h1><div class="panels">
      <section class="panel"><img class="language" alt="" src="data:image/png;base64,${crops.language}"><img alt="" src="data:image/png;base64,${crops.display}"></section>
      <section class="panel"><img alt="" src="data:image/png;base64,${crops.diagnostics}"></section>
    </div></body></html>`);
    await composer.locator("h1").evaluate((element, title) => {
      element.textContent = title;
    }, messages(locale).options_title.message);
    await readyForScreenshot(composer);
    expect(
      await composer.evaluate(() => document.documentElement.scrollHeight),
    ).toBeLessThanOrEqual(storeScreenshotSize.height);
    await composer.screenshot({
      path: path.join(localeDir, "03-options-repository-check.png"),
      animations: "disabled",
    });
  } finally {
    await composer.close();
  }
  await page.close();

  await context.unroute(
    `https://api.github.com/repos/${screenshotRepoFullName}/pulls?per_page=1&state=all`,
  );
  await context.unroute(
    `https://api.github.com/repos/${screenshotRepoFullName}/pulls/42`,
  );
  await context.unroute(
    `https://api.github.com/repos/${screenshotRepoFullName}/pulls/42/reviews**`,
  );
}

async function setPreference(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  extensionId: string,
  testId: "showReviewerName" | "showStateBadge",
  value: boolean,
): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const toggleId =
    testId === "showReviewerName"
      ? "prefs-show-reviewer-name"
      : "prefs-show-state-badge";
  const toggle = page.getByTestId(toggleId);
  const checked = await toggle.isChecked();
  if (checked !== value) {
    await toggle.click();
  }
  await page.close();
}

async function readyForScreenshot(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode()));
  });
  await page.mouse.move(0, 0);
}
