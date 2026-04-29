import { mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { chromium, expect, test } from "@playwright/test";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../..");
const extensionPath = path.join(projectRoot, ".output/chrome-mv3");
const fixturesDir = path.join(projectRoot, "tests/fixtures");
const singleRowFixture = "github-pulls-single-row.html";

type FixtureCase = {
  name: string;
  fixture: string;
  pullNumber: string;
};

const renderCases: FixtureCase[] = [
  {
    name: "standard metadata row",
    fixture: singleRowFixture,
    pullNumber: "42",
  },
  {
    name: "CSS module metadata row",
    fixture: "github-pulls-list-item-metadata.html",
    pullNumber: "42",
  },
  {
    name: "missing inline metadata wrapper",
    fixture: "github-pulls-missing-inline-meta.html",
    pullNumber: "128",
  },
  {
    name: "link-only pull number fallback",
    fixture: "github-pulls-link-only.html",
    pullNumber: "77",
  },
];

for (const fixtureCase of renderCases) {
  test(`renders reviewer chips for ${fixtureCase.name}`, async () => {
    await withExtensionContext(async (context) => {
      const fixtureHtml = await readFile(path.join(fixturesDir, fixtureCase.fixture), "utf8");

      await routeFixturePage(context, fixtureHtml);
      await routePullApi(context, fixtureCase.pullNumber, {
        user: { login: "hon454" },
        requested_reviewers: [{ login: "alice" }],
        requested_teams: [{ slug: "platform" }],
      });
      await routeReviewsApi(context, fixtureCase.pullNumber, [
        {
          state: "APPROVED",
          submitted_at: "2026-04-20T12:00:00Z",
          user: { login: "bob" },
        },
      ]);

      const page = await context.newPage();
      await page.goto("https://github.com/hon454/github-pulls-show-reviewers/pulls");

      const root = page.locator(".ghpsr-root");
      await expect(root).toContainText("Reviewers:");
      await expect(root).toContainText("Team: platform");
      await expect(root.locator('a.ghpsr-avatar[title*="@alice"]')).toHaveCount(1);
      await expect(
        root.locator('a.ghpsr-avatar[title*="@bob"][title*="approved"]'),
      ).toHaveCount(1);
    });
  });
}

test("omits the inline reviewer row when both requested and reviewed are empty", async () => {
  await withExtensionContext(async (context) => {
    const fixtureHtml = await readFile(path.join(fixturesDir, singleRowFixture), "utf8");

    await routeFixturePage(context, fixtureHtml);
    await routePullApi(context, "42", {
      user: { login: "hon454" },
      requested_reviewers: [],
      requested_teams: [],
    });
    await routeReviewsApi(context, "42", []);

    const page = await context.newPage();
    await page.goto("https://github.com/hon454/github-pulls-show-reviewers/pulls");

    await expect(page.locator(".ghpsr-root")).toBeEmpty();
  });
});

test("renders unauth-rate-limit banner with Sign in CTA when an unauthenticated row hits a 429", async () => {
  await withExtensionContext(async (context) => {
    const fixtureHtml = await readFile(
      path.join(fixturesDir, "github-pulls-with-banner-target.html"),
      "utf8",
    );

    await routeFixturePage(context, fixtureHtml);
    await context.route(
      "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42",
      async (route) => {
        await route.fulfill({
          status: 429,
          contentType: "application/json",
          headers: {
            "x-ratelimit-limit": "60",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-resource": "core",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
          },
          body: JSON.stringify({
            message: "API rate limit exceeded for 127.0.0.1.",
          }),
        });
      },
    );
    await context.route(
      "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews**",
      async (route) => {
        await route.fulfill({
          status: 429,
          contentType: "application/json",
          headers: {
            "x-ratelimit-limit": "60",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-resource": "core",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
          },
          body: JSON.stringify({
            message: "API rate limit exceeded for 127.0.0.1.",
          }),
        });
      },
    );

    const page = await context.newPage();
    await page.goto("https://github.com/hon454/github-pulls-show-reviewers/pulls");

    const banner = page.locator("[data-ghpsr-banner]");
    await expect(banner).toContainText(
      "GitHub's unauthenticated request limit was reached.",
    );
    await expect(banner).toContainText("Sign in to raise it to 5,000/hr.");
    // The fresh reset header (~10 minutes from now) should surface in the copy.
    await expect(banner).toContainText("Resets in about");
    await expect(banner.locator("a")).toHaveText("Sign in");
  });
});

test("renders app-uncovered banner with Configure access CTA when a signed-in row hits a 404", async () => {
  await withExtensionContext(async (context) => {
    const fixtureHtml = await readFile(
      path.join(fixturesDir, "github-pulls-with-banner-target.html"),
      "utf8",
    );

    // Cover the test owner with an "all" installation so resolveAccountForRepo
    // finds the seeded account. The 404 stub below then exercises the
    // app-uncovered branch (signed in, but GitHub denies the specific repo).
    await seedSignedInAccount(context, {
      accountId: "acc-banner",
      login: "hon454",
      installationOwner: "hon454",
    });

    await routeFixturePage(context, fixtureHtml);
    // Defensive stub: in case the background ever calls the installations API,
    // return an empty list rather than letting the real network handle it.
    await context.route("https://api.github.com/user/installations**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ total_count: 0, installations: [] }),
      });
    });
    await routePullApiError(context, "42", 404);
    await routeReviewsApiError(context, "42", 404);

    const page = await context.newPage();
    await page.goto("https://github.com/hon454/github-pulls-show-reviewers/pulls");

    const banner = page.locator("[data-ghpsr-banner]");
    await expect(banner).toContainText(
      "Add hon454/github-pulls-show-reviewers to @hon454's GitHub App installation",
    );
    const cta = banner.locator("a");
    await expect(cta).toHaveText("Configure access");
    await expect(cta).toHaveAttribute(
      "href",
      /github\.com\/apps\/.*\/installations\/new/,
    );
  });
});

test("clears the reviewer slot silently when review history is denied", async () => {
  await withExtensionContext(async (context) => {
    const fixtureHtml = await readFile(path.join(fixturesDir, singleRowFixture), "utf8");

    await routeFixturePage(context, fixtureHtml);
    await routePullApi(context, "42", {
      user: { login: "hon454" },
      requested_reviewers: [{ login: "alice" }],
      requested_teams: [],
    });
    await context.route(
      "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews",
      async (route) => {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          headers: {
            "x-ratelimit-limit": "60",
            "x-ratelimit-remaining": "0",
          },
          body: JSON.stringify({
            message: "API rate limit exceeded for 127.0.0.1.",
          }),
        });
      },
    );

    const page = await context.newPage();
    await page.goto("https://github.com/hon454/github-pulls-show-reviewers/pulls");

    // Row-level error rendering is removed; failures silently clear the reviewer slot.
    await expect(page.locator(".ghpsr-status--error")).toHaveCount(0);
    // The root mount is either absent or empty after a fetch failure.
    const root = page.locator(".ghpsr-root");
    const rootCount = await root.count();
    if (rootCount > 0) {
      await expect(root).toBeEmpty();
    }
  });
});

async function withExtensionContext(
  run: (context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>) => Promise<void>,
): Promise<void> {
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
    await settleExtensionInstallUi(context);
    await run(context);
  } finally {
    await context.close();
  }
}

async function settleExtensionInstallUi(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
): Promise<void> {
  const closeExtensionPages = async () => {
    await Promise.all(
      context
        .pages()
        .filter((page) => page.url().startsWith("chrome-extension://"))
        .map(async (page) => {
          await page.close().catch(() => {});
        }),
    );
  };

  await closeExtensionPages();

  const maybeInstallPage = await context
    .waitForEvent("page", {
      timeout: 1_000,
    })
    .catch(() => null);

  if (maybeInstallPage) {
    await maybeInstallPage.waitForLoadState("domcontentloaded").catch(() => {});
    await closeExtensionPages();
  }
}

async function routeFixturePage(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  fixtureHtml: string,
): Promise<void> {
  await context.route("https://github.com/hon454/github-pulls-show-reviewers/pulls", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: fixtureHtml,
    });
  });
}

async function routePullApi(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  pullNumber: string,
  payload: object,
): Promise<void> {
  await context.route(
    `https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/${pullNumber}`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    },
  );
}

async function routeReviewsApi(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  pullNumber: string,
  payload: object,
): Promise<void> {
  await context.route(
    `https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/${pullNumber}/reviews**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    },
  );
}

async function routePullApiError(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  pullNumber: string,
  status: number,
): Promise<void> {
  await context.route(
    `https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/${pullNumber}`,
    async (route) => {
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ message: `status ${status}` }),
      });
    },
  );
}

async function routeReviewsApiError(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  pullNumber: string,
  status: number,
): Promise<void> {
  await context.route(
    `https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/${pullNumber}/reviews**`,
    async (route) => {
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ message: `status ${status}` }),
      });
    },
  );
}

async function seedSignedInAccount(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  input: {
    accountId: string;
    login: string;
    installationOwner: string;
  },
): Promise<void> {
  const serviceWorker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(serviceWorker.url()).host;
  const optionsPage = await context.newPage();
  try {
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await optionsPage.evaluate((seed) => {
      const now = Date.now();
      const storage = (
        globalThis as unknown as {
          chrome: { storage: { local: { set(items: object): Promise<void> } } };
        }
      ).chrome.storage.local;
      return storage.set({
        settings: { version: 4, accountIds: [seed.accountId] },
        [`account:profile:${seed.accountId}`]: {
          id: seed.accountId,
          login: seed.login,
          avatarUrl: null,
          createdAt: now,
        },
        [`account:auth:${seed.accountId}`]: {
          token: "ghu_seeded",
          invalidated: false,
          invalidatedReason: null,
          refreshToken: null,
          expiresAt: null,
          refreshTokenExpiresAt: null,
        },
        [`account:installations:${seed.accountId}`]: {
          installations: [
            {
              id: 1,
              account: {
                login: seed.installationOwner,
                type: "Organization",
                avatarUrl: null,
              },
              repositorySelection: "all",
              repoFullNames: null,
            },
          ],
          installationsRefreshedAt: now,
        },
      });
    }, input);
  } finally {
    await optionsPage.close();
  }
}
