import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, type Page, test } from "@playwright/test";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../..");
const extensionPath = path.join(projectRoot, ".output/chrome-mv3");
const outputDir = path.join(projectRoot, "docs/chrome-web-store-assets");
const pullsFixturePath = path.join(projectRoot, "tests/fixtures/github-pulls.html");

const screenshotRepo = {
  owner: "Northstar",
  repo: "atlas-ui",
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

type PullScene = {
  pullNumber: string;
  summary: {
    user: { login: string };
    requested_reviewers: Array<{ login: string; avatar_url: string }>;
    requested_teams: Array<{ slug: string }>;
  };
  reviews: ReviewPayload[];
  expectedLogins: string[];
  expectedTeamText?: string;
  expectedBadgeClasses: string[];
};

const avatarBase = "https://avatars.example.test/reviewers";
const avatarUrl = (login: string): string => `${avatarBase}/${login}.svg`;

const avatarStateScenes: PullScene[] = [
  {
    pullNumber: "200",
    summary: {
      user: { login: "mira" },
      requested_reviewers: [
        { login: "ava", avatar_url: avatarUrl("ava") },
      ],
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
    expectedTeamText: "Team: design-systems",
    expectedBadgeClasses: ["ghpsr-badge--approved"],
  },
  {
    pullNumber: "199",
    summary: {
      user: { login: "mira" },
      requested_reviewers: [
        { login: "mona", avatar_url: avatarUrl("mona") },
      ],
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
      requested_reviewers: [
        { login: "jules", avatar_url: avatarUrl("jules") },
      ],
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
    expectedLogins: ["jules", "riley"],
    expectedBadgeClasses: ["ghpsr-badge--refresh", "ghpsr-badge--commented"],
  },
  {
    pullNumber: "192",
    summary: {
      user: { login: "mira" },
      requested_reviewers: [
        { login: "nara", avatar_url: avatarUrl("nara") },
      ],
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
      requested_reviewers: [
        { login: "sol", avatar_url: avatarUrl("sol") },
      ],
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

test("capture Chrome Web Store assets", async () => {
  await mkdir(outputDir, { recursive: true });

  await withExtensionContext(async (context, extensionId) => {
    await routePullsFixture(context);
    await routeSyntheticAvatars(context);
    await captureBeforeAfterScreenshot(context);
    await captureAvatarStateShowcase(context);
    await captureOptionsScreenshot(context, extensionId);
  });
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
    viewport: { width: 1280, height: 720 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const serviceWorker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    expect(serviceWorker.url()).toContain("chrome-extension://");
    const extensionId = new URL(serviceWorker.url()).host;
    await run(context, extensionId);
  } finally {
    await context.close();
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
    viewport: { width: 1280, height: 720 },
  });

  try {
    await run(context);
  } finally {
    await context.close();
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
    const fileName = new URL(route.request().url()).pathname.split("/").pop() ?? "";
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
    routeUrls.push(pullRoute, reviewsRoute);

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
  }

  return async () => {
    for (const routeUrl of routeUrls) {
      await context.unroute(routeUrl);
    }
  };
}

async function assertReviewerScenes(page: Page, scenes: PullScene[]): Promise<void> {
  const root = page.locator(".ghpsr-root");
  await expect(root.filter({ hasText: "Reviewers:" })).toHaveCount(scenes.length);

  for (const scene of scenes) {
    for (const login of scene.expectedLogins) {
      await expect(root.locator(`a.ghpsr-avatar[title*="@${login}"]`)).toHaveCount(1);
    }
    for (const badgeClass of scene.expectedBadgeClasses) {
      expect(await root.locator(`.${badgeClass}`).count()).toBeGreaterThan(0);
    }
    if (scene.expectedTeamText != null) {
      await expect(root.filter({ hasText: scene.expectedTeamText })).toHaveCount(1);
    }
  }
}

async function assertFixtureCopy(page: Page): Promise<void> {
  await expect(page.locator(".repo")).toContainText(screenshotRepo.owner);
  await expect(page.locator(".repo")).toContainText(screenshotRepo.repo);
  await expect(page.getByRole("link", { name: fixturePrimaryTitle })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("CINEV");
  await expect(page.locator("body")).not.toContainText("shotloom");
}

async function stabilizePullListForScreenshot(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
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
    await page.screenshot({ path: filePath });
  } finally {
    await page.close();
  }
}

async function captureMockedAfterScreenshot(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  scenes: PullScene[],
  filePath: string,
): Promise<void> {
  const unrouteReviewerScenes = await routeReviewerScenes(context, scenes);
  const page = await context.newPage();
  try {
    await page.goto(screenshotPullsUrl);
    await assertFixtureCopy(page);
    await assertReviewerScenes(page, scenes);
    await stabilizePullListForScreenshot(page);
    await page.screenshot({ path: filePath });
  } finally {
    await page.close();
    await unrouteReviewerScenes();
  }
}

async function captureBeforeAfterScreenshot(
  extensionContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
): Promise<void> {
  const beforePath = path.join(outputDir, "01-pr-list-before.tmp.png");
  const afterPath = path.join(outputDir, "01-pr-list-after.tmp.png");
  const combinedPath = path.join(outputDir, "01-pr-list-before-after.png");

  await withPlainContext(async (plainContext) => {
    await captureMockedBeforeScreenshot(plainContext, beforePath);
  });

  await captureMockedAfterScreenshot(extensionContext, avatarStateScenes, afterPath);

  const composer = await extensionContext.newPage();
  try {
    const beforeData = (await readFile(beforePath)).toString("base64");
    const afterData = (await readFile(afterPath)).toString("base64");
    await composer.setViewportSize({ width: 1280, height: 720 });
    await composer.setContent(`
      <!doctype html>
      <html>
        <head>
          <style>
            body {
              margin: 0;
              background: #0d1117;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            .frame {
              width: 1280px;
              height: 720px;
              box-sizing: border-box;
              padding: 24px;
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 18px;
            }
            .panel {
              height: 660px;
              overflow: hidden;
              border: 1px solid #30363d;
              border-radius: 10px;
              background: #010409;
              box-shadow: 0 18px 45px rgba(0, 0, 0, 0.35);
            }
            .label {
              height: 42px;
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
              transform: translate(0, -1%);
              transform-origin: top left;
            }
          </style>
        </head>
        <body>
          <div class="frame">
            <section class="panel">
              <div class="label">Before</div>
              <img alt="" src="data:image/png;base64,${beforeData}">
            </section>
            <section class="panel">
              <div class="label">After</div>
              <img alt="" src="data:image/png;base64,${afterData}">
            </section>
          </div>
        </body>
      </html>
    `);
    await composer.screenshot({ path: combinedPath });
  } finally {
    await composer.close();
    await rm(beforePath, { force: true });
    await rm(afterPath, { force: true });
  }
}

async function captureAvatarStateShowcase(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
): Promise<void> {
  await captureMockedAfterScreenshot(
    context,
    avatarStateScenes,
    path.join(outputDir, "02-pr-list-avatar-state-showcase.png"),
  );
}

async function captureOptionsScreenshot(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  extensionId: string,
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
          requested_reviewers: [
            { login: "ava", avatar_url: avatarUrl("ava") },
          ],
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
  await expect(page.locator("body")).toContainText("without a token");
  await page.screenshot({
    path: path.join(outputDir, "03-options-repository-check.png"),
  });
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
