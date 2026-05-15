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
  {
    name: "title-only metadata fallback",
    fixture: "github-pulls-title-only-metadata.html",
    pullNumber: "203",
  },
  {
    name: "non-primary pull link fallback",
    fixture: "github-pulls-non-primary-link.html",
    pullNumber: "314",
  },
];

for (const fixtureCase of renderCases) {
  test(`renders reviewer chips for ${fixtureCase.name}`, async () => {
    await withExtensionContext(async (context) => {
      const fixtureHtml = await readFile(
        path.join(fixturesDir, fixtureCase.fixture),
        "utf8",
      );

      await routeFixturePage(context, fixtureHtml);
      await routePullListApi(context, [
        {
          number: Number(fixtureCase.pullNumber),
          user: { login: "hon454" },
          requested_reviewers: [{ login: "alice" }],
          requested_teams: [{ slug: "platform" }],
        },
      ]);
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
      await page.goto(
        "https://github.com/hon454/github-pulls-show-reviewers/pulls",
      );

      const root = page.locator(".ghpsr-root");
      await expect(root).toContainText("Reviewers:");
      await expect(root).toContainText("Team: platform");
      await expect(root.locator('a.ghpsr-avatar[title*="@alice"]')).toHaveCount(
        1,
      );
      await expect(
        root.locator('a.ghpsr-avatar[title*="@bob"][title*="approved"]'),
      ).toHaveCount(1);
    });
  });
}

test("omits the inline reviewer row when both requested and reviewed are empty", async () => {
  await withExtensionContext(async (context) => {
    const fixtureHtml = await readFile(
      path.join(fixturesDir, singleRowFixture),
      "utf8",
    );

    await routeFixturePage(context, fixtureHtml);
    await routePullListApi(context, [
      {
        number: 42,
        user: { login: "hon454" },
        requested_reviewers: [],
        requested_teams: [],
      },
    ]);
    await routePullApi(context, "42", {
      user: { login: "hon454" },
      requested_reviewers: [],
      requested_teams: [],
    });
    await routeReviewsApi(context, "42", []);

    const page = await context.newPage();
    await page.goto(
      "https://github.com/hon454/github-pulls-show-reviewers/pulls",
    );

    await expect(page.locator(".ghpsr-root")).toBeEmpty();
  });
});

test("renders reviewer chips after a same-repository GitHub rerender", async () => {
  await withExtensionContext(async (context) => {
    const initialFixtureHtml = await readFile(
      path.join(fixturesDir, singleRowFixture),
      "utf8",
    );
    const rerenderFixtureHtml = await readFile(
      path.join(fixturesDir, "github-pulls-missing-inline-meta.html"),
      "utf8",
    );

    await routeFixturePage(context, initialFixtureHtml);
    await routePullListApi(context, [
      {
        number: 42,
        user: { login: "hon454" },
        requested_reviewers: [{ login: "alice" }],
        requested_teams: [],
      },
      {
        number: 128,
        user: { login: "hon454" },
        requested_reviewers: [{ login: "charlie" }],
        requested_teams: [{ slug: "design-systems" }],
      },
    ]);
    await routePullApi(context, "42", {
      user: { login: "hon454" },
      requested_reviewers: [{ login: "alice" }],
      requested_teams: [],
    });
    await routePullApi(context, "128", {
      user: { login: "hon454" },
      requested_reviewers: [{ login: "charlie" }],
      requested_teams: [{ slug: "design-systems" }],
    });
    await routeReviewsApi(context, "42", []);
    await routeReviewsApi(context, "128", [
      {
        state: "APPROVED",
        submitted_at: "2026-04-20T12:00:00Z",
        user: { login: "dana" },
      },
    ]);

    const page = await context.newPage();
    await page.goto(
      "https://github.com/hon454/github-pulls-show-reviewers/pulls",
    );
    await expect(page.locator('a.ghpsr-avatar[title*="@alice"]')).toHaveCount(
      1,
    );

    await page.evaluate((html) => {
      const nextDocument = new DOMParser().parseFromString(html, "text/html");
      const nextContainer = nextDocument.querySelector(
        ".js-navigation-container",
      );
      const currentContainer = document.querySelector(
        ".js-navigation-container",
      );
      if (nextContainer == null || currentContainer == null) {
        throw new Error("fixture navigation container missing");
      }
      window.history.pushState(
        {},
        "",
        "/hon454/github-pulls-show-reviewers/pulls?page=2",
      );
      currentContainer.replaceWith(nextContainer);
      document.dispatchEvent(new Event("turbo:render", { bubbles: true }));
    }, rerenderFixtureHtml);

    const root = page.locator(".ghpsr-root");
    await expect(root).toContainText("Reviewers:");
    await expect(root).toContainText("Team: design-systems");
    await expect(root.locator('a.ghpsr-avatar[title*="@charlie"]')).toHaveCount(
      1,
    );
    await expect(
      root.locator('a.ghpsr-avatar[title*="@dana"][title*="approved"]'),
    ).toHaveCount(1);
  });
});

test("clears metadata-missing reviewer slots silently when reviewer fetch fails", async () => {
  await withExtensionContext(async (context) => {
    const fixtureHtml = await readFile(
      path.join(fixturesDir, "github-pulls-title-only-metadata.html"),
      "utf8",
    );

    await routeFixturePage(context, fixtureHtml);
    await routePullListApi(context, []);
    let pullRequestCount = 0;
    let reviewsRequestCount = 0;
    await context.route(
      "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/203",
      async (route) => {
        pullRequestCount += 1;
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ message: "status 403" }),
        });
      },
    );
    await context.route(
      "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/203/reviews**",
      async (route) => {
        reviewsRequestCount += 1;
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ message: "status 403" }),
        });
      },
    );

    const page = await context.newPage();
    await page.goto(
      "https://github.com/hon454/github-pulls-show-reviewers/pulls",
    );

    await expect.poll(() => pullRequestCount).toBe(1);
    await expect.poll(() => reviewsRequestCount).toBe(1);
    await expect(page.locator(".ghpsr-status--error")).toHaveCount(0);
    const root = page.locator(".ghpsr-root");
    await expect(root).toHaveCount(1);
    await expect(root).toBeEmpty();
  });
});

test("renders unauth-rate-limit banner with Sign in CTA when an unauthenticated row hits a 429", async () => {
  await withExtensionContext(async (context) => {
    const fixtureHtml = await readFile(
      path.join(fixturesDir, "github-pulls-with-banner-target.html"),
      "utf8",
    );

    await routeFixturePage(context, fixtureHtml);
    await routePullListApi(context, []);
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
    await page.goto(
      "https://github.com/hon454/github-pulls-show-reviewers/pulls",
    );

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
    await routePullListApi(context, []);
    // Defensive stub: in case the background ever calls the installations API,
    // return an empty list rather than letting the real network handle it.
    await context.route(
      "https://api.github.com/user/installations**",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ total_count: 0, installations: [] }),
        });
      },
    );
    await routePullApiError(context, "42", 404);
    await routeReviewsApiError(context, "42", 404);

    const page = await context.newPage();
    await page.goto(
      "https://github.com/hon454/github-pulls-show-reviewers/pulls",
    );

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

test("refreshes an expired selected-installation account before rendering private reviewer metadata", async () => {
  await withExtensionContext(async (context) => {
    const fixtureHtml = await readFile(
      path.join(fixturesDir, singleRowFixture),
      "utf8",
    );
    const now = Date.now();
    const refreshRequests: string[] = [];
    const metadataAuthHeaders: string[] = [];
    const reviewsAuthHeaders: string[] = [];

    await seedSignedInAccount(context, {
      accountId: "acc-refresh",
      login: "hon454",
      installationOwner: "hon454",
      repositorySelection: "selected",
      repoFullNames: ["hon454/github-pulls-show-reviewers"],
      token: "ghu_expired",
      refreshToken: "ghr_refresh",
      expiresAt: now - 60_000,
      refreshTokenExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
    });

    await routeFixturePage(context, fixtureHtml);
    await context.route(
      "https://github.com/login/oauth/access_token",
      async (route) => {
        refreshRequests.push(route.request().postData() ?? "");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            access_token: "ghu_refreshed",
            token_type: "bearer",
            refresh_token: "ghr_rotated",
            expires_in: 28_800,
            refresh_token_expires_in: 158_976_000,
          }),
        });
      },
    );
    await context.route(
      /^https:\/\/api\.github\.com\/repos\/hon454\/github-pulls-show-reviewers\/pulls\?/,
      async (route) => {
        const authorization = route.request().headers().authorization ?? "";
        metadataAuthHeaders.push(authorization);
        if (authorization === "Bearer ghu_expired") {
          await route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({ message: "Bad credentials" }),
          });
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              number: 42,
              user: { login: "hon454" },
              requested_reviewers: [{ login: "alice" }],
              requested_teams: [{ slug: "platform" }],
            },
          ]),
        });
      },
    );
    await context.route(
      "https://api.github.com/repos/hon454/github-pulls-show-reviewers/pulls/42/reviews**",
      async (route) => {
        const authorization = route.request().headers().authorization ?? "";
        reviewsAuthHeaders.push(authorization);
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
    await page.goto(
      "https://github.com/hon454/github-pulls-show-reviewers/pulls",
    );

    const root = page.locator(".ghpsr-root");
    await expect(root).toContainText("Reviewers:");
    await expect(root).toContainText("Team: platform");
    await expect(root.locator('a.ghpsr-avatar[title*="@alice"]')).toHaveCount(
      1,
    );
    await expect(
      root.locator('a.ghpsr-avatar[title*="@bob"][title*="approved"]'),
    ).toHaveCount(1);
    expect(refreshRequests).toHaveLength(1);
    expect(refreshRequests[0]).toContain("grant_type=refresh_token");
    expect(refreshRequests[0]).toContain("refresh_token=ghr_refresh");
    expect(metadataAuthHeaders[0]).toBe("Bearer ghu_expired");
    expect(metadataAuthHeaders).toContain("Bearer ghu_refreshed");
    expect(
      metadataAuthHeaders.filter((header) => header === "Bearer ghu_expired"),
    ).toHaveLength(1);
    expect(
      metadataAuthHeaders.every(
        (header) =>
          header === "Bearer ghu_refreshed" || header === "Bearer ghu_expired",
      ),
    ).toBe(true);
    expect(
      reviewsAuthHeaders.every((header) => header === "Bearer ghu_refreshed"),
    ).toBe(true);
    await expectStoredAuth(context, "acc-refresh", {
      token: "ghu_refreshed",
      refreshToken: "ghr_rotated",
      invalidated: false,
      invalidatedReason: null,
    });
  });
});

test("clears the reviewer slot silently when review history is denied", async () => {
  await withExtensionContext(async (context) => {
    const fixtureHtml = await readFile(
      path.join(fixturesDir, singleRowFixture),
      "utf8",
    );

    await routeFixturePage(context, fixtureHtml);
    await routePullListApi(context, []);
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
    await page.goto(
      "https://github.com/hon454/github-pulls-show-reviewers/pulls",
    );

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
  run: (
    context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  ) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "ghpsr-playwright-"),
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
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
  await context.route(
    "https://github.com/hon454/github-pulls-show-reviewers/pulls",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: fixtureHtml,
      });
    },
  );
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

async function routePullListApi(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  payload: object,
): Promise<void> {
  await context.route(
    /^https:\/\/api\.github\.com\/repos\/hon454\/github-pulls-show-reviewers\/pulls\?/,
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
    repositorySelection?: "all" | "selected";
    repoFullNames?: string[] | null;
    token?: string;
    refreshToken?: string | null;
    expiresAt?: number | null;
    refreshTokenExpiresAt?: number | null;
  },
): Promise<void> {
  const serviceWorker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
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
          token: seed.token ?? "ghu_seeded",
          invalidated: false,
          invalidatedReason: null,
          refreshToken: seed.refreshToken ?? null,
          expiresAt: seed.expiresAt ?? null,
          refreshTokenExpiresAt: seed.refreshTokenExpiresAt ?? null,
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
              repositorySelection: seed.repositorySelection ?? "all",
              repoFullNames: seed.repoFullNames ?? null,
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

async function expectStoredAuth(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  accountId: string,
  expected: {
    token: string;
    refreshToken: string | null;
    invalidated: boolean;
    invalidatedReason: string | null;
  },
): Promise<void> {
  const serviceWorker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(serviceWorker.url()).host;
  const optionsPage = await context.newPage();
  try {
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    const stored = await optionsPage.evaluate((id) => {
      const storage = (
        globalThis as unknown as {
          chrome: {
            storage: {
              local: { get(key: string): Promise<Record<string, unknown>> };
            };
          };
        }
      ).chrome.storage.local;
      return storage.get(`account:auth:${id}`);
    }, accountId);
    expect(stored[`account:auth:${accountId}`]).toMatchObject(expected);
  } finally {
    await optionsPage.close();
  }
}
