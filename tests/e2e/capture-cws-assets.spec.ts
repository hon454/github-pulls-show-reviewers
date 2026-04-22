import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, test } from "@playwright/test";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../..");
const extensionPath = path.join(projectRoot, ".output/chrome-mv3");
const outputDir = path.join(projectRoot, "docs/chrome-web-store-assets");

test.describe.configure({ mode: "serial" });

test("capture Chrome Web Store assets", async () => {
  await mkdir(outputDir, { recursive: true });

  await withExtensionContext(async (context, extensionId) => {
    await capturePullListScreenshot(context, {
      fixture: "github-pulls.html",
      fileName: "01-pr-list-requested-and-reviewed.png",
      pullNumber: "42",
      summary: {
        user: { login: "hon454" },
        requested_reviewers: [{ login: "alice" }],
        requested_teams: [{ slug: "platform" }],
      },
      reviews: [
        {
          state: "APPROVED",
          submitted_at: "2026-04-20T12:00:00Z",
          user: { login: "bob" },
        },
      ],
      expectedLogins: ["alice", "bob"],
      expectedTeamText: "Team: platform",
    });

    await setPreference(context, extensionId, "showReviewerName", true);
    await capturePullListScreenshot(context, {
      fixture: "github-pulls-list-item-metadata.html",
      fileName: "02-pr-list-mixed-review-states.png",
      pullNumber: "42",
      summary: {
        user: { login: "hon454" },
        requested_reviewers: [{ login: "jules" }],
        requested_teams: [{ slug: "security" }],
      },
      reviews: [
        {
          state: "CHANGES_REQUESTED",
          submitted_at: "2026-04-20T12:05:00Z",
          user: { login: "kian" },
        },
      ],
      expectedLogins: ["jules", "kian"],
      expectedTeamText: "Team: security",
      expectedNamePills: ["@jules", "@kian"],
    });

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

async function capturePullListScreenshot(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  scene: {
    fixture: string;
    fileName: string;
    pullNumber: string;
    summary: object;
    reviews: object[];
    expectedLogins: string[];
    expectedTeamText: string;
    expectedNamePills?: string[];
  },
): Promise<void> {
  const fixturePath = path.join(projectRoot, "tests/fixtures", scene.fixture);
  const fixtureHtml = await readFile(fixturePath, "utf8");

  await context.route("https://github.com/hon454/github-pulls-show-reviewers/pulls", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: fixtureHtml,
    });
  });

  await context.route(
    `https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/${scene.pullNumber}`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scene.summary),
      });
    },
  );

  await context.route(
    `https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/${scene.pullNumber}/reviews`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scene.reviews),
      });
    },
  );

  const page = await context.newPage();
  await page.goto("https://github.com/hon454/github-pulls-show-reviewers/pulls");

  const root = page.locator(".ghpsr-root");
  await expect(root).toContainText("Reviewers:");
  await expect(root).toContainText(scene.expectedTeamText);
  for (const login of scene.expectedLogins) {
    await expect(
      root.locator(
        `a.ghpsr-avatar[title*="@${login}"], a.ghpsr-pill[title*="@${login}"]`,
      ),
    ).toHaveCount(1);
  }
  for (const pill of scene.expectedNamePills ?? []) {
    await expect(root).toContainText(pill);
  }

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
  await page.screenshot({
    path: path.join(outputDir, scene.fileName),
  });
  await page.close();

  await context.unroute("https://github.com/hon454/github-pulls-show-reviewers/pulls");
  await context.unroute(
    `https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/${scene.pullNumber}`,
  );
  await context.unroute(
    `https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/${scene.pullNumber}/reviews`,
  );
}

async function captureOptionsScreenshot(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  extensionId: string,
): Promise<void> {
  await setPreference(context, extensionId, "showReviewerName", true);

  await context.route(
    "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls?per_page=1&state=all",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ number: 42 }]),
      });
    },
  );

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
            submitted_at: "2026-04-20T09:00:00Z",
            user: { login: "bob" },
          },
        ]),
      });
    },
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page.getByTestId("prefs-show-reviewer-name")).toBeChecked();
  await page.getByTestId("diagnostics-repo").fill("hon454/github-pulls-show-reviewers");
  await page.getByTestId("diagnostics-no-token").click();
  await expect(page.locator("body")).toContainText("without a token");
  await page.screenshot({
    path: path.join(outputDir, "03-options-repository-check.png"),
  });
  await page.close();

  await context.unroute(
    "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls?per_page=1&state=all",
  );
  await context.unroute(
    "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42",
  );
  await context.unroute(
    "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews",
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
