/* global console */

import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const extensionPath = path.join(projectRoot, ".output/chrome-mv3");
const outputDir = path.join(projectRoot, "docs/chrome-web-store-assets");
const githubHost = "https://github.com";
const apiHost = "https://api.github.com";
const repository = "hon454/github-pulls-show-reviewers";

await mkdir(outputDir, { recursive: true });
const userDataDir = await mkdtemp(path.join(os.tmpdir(), "ghpsr-cws-"));

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
  viewport: {
    width: 1280,
    height: 800,
  },
  deviceScaleFactor: 1,
});

try {
  console.log("Waiting for extension service worker...");
  const serviceWorker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(serviceWorker.url()).host;
  console.log(`Extension ready: ${extensionId}`);

  await capturePullListScreenshot(context, {
    path: path.join(outputDir, "01-pr-list-requested-and-reviewed.png"),
    rows: [
      {
        number: 42,
        title: "Add reviewer chips to pull request rows",
        openedBy: "hon454",
        summary: {
          user: { login: "hon454" },
          requested_reviewers: [{ login: "alice" }, { login: "maria" }],
          requested_teams: [{ slug: "platform" }],
        },
        reviews: [
          {
            state: "APPROVED",
            submitted_at: "2026-04-20T09:00:00Z",
            user: { login: "bob" },
          },
        ],
      },
      {
        number: 43,
        title: "Handle missing metadata wrappers safely",
        openedBy: "sora",
        summary: {
          user: { login: "sora" },
          requested_reviewers: [{ login: "dana" }],
          requested_teams: [{ slug: "frontend" }],
        },
        reviews: [
          {
            state: "COMMENTED",
            submitted_at: "2026-04-20T10:15:00Z",
            user: { login: "eric" },
          },
        ],
      },
    ],
  });

  await capturePullListScreenshot(context, {
    path: path.join(outputDir, "02-pr-list-mixed-review-states.png"),
    rows: [
      {
        number: 51,
        title: "Document public repository no-token behavior",
        openedBy: "hon454",
        summary: {
          user: { login: "hon454" },
          requested_reviewers: [{ login: "alice" }],
          requested_teams: [],
        },
        reviews: [
          {
            state: "APPROVED",
            submitted_at: "2026-04-20T11:00:00Z",
            user: { login: "bob" },
          },
        ],
      },
      {
        number: 52,
        title: "Tighten repository diagnostics for private-like responses",
        openedBy: "mira",
        summary: {
          user: { login: "mira" },
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
      },
      {
        number: 53,
        title: "Preserve reviewer-only scope in options messaging",
        openedBy: "nina",
        summary: {
          user: { login: "nina" },
          requested_reviewers: [],
          requested_teams: [],
        },
        reviews: [
          {
            state: "DISMISSED",
            submitted_at: "2026-04-20T12:40:00Z",
            user: { login: "owen" },
          },
        ],
      },
    ],
  });

  await captureOptionsScreenshot(context, extensionId);
} finally {
  await context.close();
}

async function capturePullListScreenshot(context, scene) {
  console.log(`Capturing ${path.basename(scene.path)}...`);
  await routeGitHubPullScene(context, scene.rows);
  const page = await context.newPage();
  await page.goto(
    `${githubHost}/${repository}/pulls?scene=${encodeURIComponent(scene.path)}`,
  );
  await page.waitForSelector(".ghpsr-chip", { timeout: 15000 });
  await page.screenshot({ path: scene.path });
  await page.close();
  await context.unroute(`${githubHost}/${repository}/pulls*`);
  await context.unroute(`${apiHost}/repos/${repository}/pulls?*`);
  await context.unroute(`${apiHost}/repos/${repository}/pulls/**`);
}

async function captureOptionsScreenshot(context, extensionId) {
  console.log("Capturing 03-options-repository-check.png...");
  await routeRepositoryDiagnosticsSuccess(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.getByRole("button", { name: "Check no-token repository" }).click();
  await page.waitForSelector("text=without a token", { timeout: 15000 });
  await page.locator("body").evaluate((body) => {
    body.style.zoom = "0.88";
  });
  await page.screenshot({
    path: path.join(outputDir, "03-options-repository-check.png"),
  });
  await page.close();
  await context.unroute(`${apiHost}/repos/${repository}/pulls?*`);
  await context.unroute(`${apiHost}/repos/${repository}/pulls/**`);
}

async function routeGitHubPullScene(context, rows) {
  await context.route(`${githubHost}/${repository}/pulls*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: renderPullListHtml(rows),
    });
  });

  await context.route(
    `${apiHost}/repos/${repository}/pulls?*`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows.map((row) => ({ number: row.number }))),
      });
    },
  );

  await context.route(
    `${apiHost}/repos/${repository}/pulls/**`,
    async (route) => {
      const url = new URL(route.request().url());
      const match = url.pathname.match(/\/pulls\/(\d+)(\/reviews)?$/);
      const pullNumber = Number.parseInt(match?.[1] ?? "", 10);
      const isReviews = match?.[2] === "/reviews";
      const row = rows.find((entry) => entry.number === pullNumber);

      if (!row) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ message: "Not Found" }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(isReviews ? row.reviews : row.summary),
      });
    },
  );
}

async function routeRepositoryDiagnosticsSuccess(context) {
  await context.route(
    `${apiHost}/repos/${repository}/pulls?*`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ number: 42 }]),
      });
    },
  );

  await context.route(
    `${apiHost}/repos/${repository}/pulls/**`,
    async (route) => {
      const url = new URL(route.request().url());
      const isReviews = url.pathname.endsWith("/reviews");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          isReviews
            ? [
                {
                  state: "APPROVED",
                  submitted_at: "2026-04-20T09:00:00Z",
                  user: { login: "bob" },
                },
              ]
            : {
                user: { login: "hon454" },
                requested_reviewers: [{ login: "alice" }],
                requested_teams: [{ slug: "platform" }],
              },
        ),
      });
    },
  );
}

function renderPullListHtml(rows) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>GitHub Pulls Show Reviewers</title>
    <style>
      :root {
        color-scheme: light;
        --border: #d0d7de;
        --muted: #57606a;
        --surface: #ffffff;
        --surface-muted: #f6f8fa;
        --bg: #f6f8fa;
        --text: #1f2328;
        --link: #0969da;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, sans-serif;
        background: var(--bg);
        color: var(--text);
      }
      .page {
        width: 1280px;
        height: 800px;
        padding: 36px 48px;
        overflow: hidden;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 24px;
      }
      .title {
        margin: 0;
        font-size: 28px;
        font-weight: 700;
      }
      .subtitle {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 14px;
      }
      .repo-pill {
        border: 1px solid var(--border);
        background: var(--surface);
        border-radius: 999px;
        padding: 8px 14px;
        font-size: 13px;
        color: var(--muted);
      }
      .list {
        border: 1px solid var(--border);
        border-radius: 16px;
        overflow: hidden;
        background: var(--surface);
        box-shadow: 0 14px 40px rgba(31, 35, 40, 0.08);
      }
      .list-header {
        display: grid;
        grid-template-columns: 1.6fr 0.8fr 0.6fr;
        gap: 16px;
        padding: 16px 24px;
        background: var(--surface-muted);
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: uppercase;
      }
      .js-issue-row {
        padding: 22px 24px;
        border-top: 1px solid var(--border);
      }
      .js-issue-row:first-of-type {
        border-top: 0;
      }
      .row-grid {
        display: grid;
        grid-template-columns: 1.6fr 0.8fr 0.6fr;
        gap: 16px;
        align-items: start;
      }
      .Link--primary {
        color: var(--link);
        text-decoration: none;
        font-size: 18px;
        font-weight: 600;
      }
      .Link--primary:hover {
        text-decoration: underline;
      }
      .d-flex.mt-1.text-small.color-fg-muted {
        margin-top: 8px;
        color: var(--muted);
        font-size: 13px;
      }
      .meta-col {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }
      .status-col {
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        min-height: 32px;
        color: var(--muted);
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="header">
        <div>
          <h1 class="title">Pull requests</h1>
          <p class="subtitle">Reviewer visibility stays inline with each pull request row.</p>
        </div>
        <div class="repo-pill">${repository}</div>
      </div>
      <div class="list">
        <div class="list-header">
          <div>Title</div>
          <div>Author</div>
          <div>Status</div>
        </div>
        ${rows
          .map(
            (row) => `
              <div class="js-issue-row" id="issue_${row.number}">
                <div class="row-grid">
                  <div>
                    <a class="Link--primary" href="/${repository}/pull/${row.number}">
                      ${escapeHtml(row.title)}
                    </a>
                    <div class="d-flex mt-1 text-small color-fg-muted">
                      <span class="d-none d-md-inline-flex">
                        <span class="issue-meta-section ml-2">#${row.number} opened by ${escapeHtml(row.openedBy)}</span>
                      </span>
                    </div>
                  </div>
                  <div class="meta-col">@${escapeHtml(row.openedBy)}</div>
                  <div class="status-col">Open</div>
                </div>
              </div>
            `,
          )
          .join("")}
      </div>
    </div>
  </body>
</html>`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
