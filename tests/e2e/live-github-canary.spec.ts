import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { chromium, expect, test, type Page } from "@playwright/test";

import { githubSelectors } from "../../src/github/selectors";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../..");
const extensionPath = path.join(projectRoot, ".output/chrome-mv3");
const liveRepository = process.env.LIVE_GITHUB_REPOSITORY ?? "cli/cli";

type CanarySnapshot = {
  rowCount: number;
  pullNumbers: string[];
  mountCount: number;
};

type ApiResponseObservation = {
  path: string;
  status: number;
  rateLimit: {
    limit: string | null;
    remaining: string | null;
    reset: string | null;
    resource: string | null;
  };
};

test("discovers live GitHub PR rows and creates reviewer mounts", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  expect(liveRepository).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "ghpsr-live-canary-"),
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  let apiRequestCount = 0;
  let apiRequestsWithAuthorization = 0;
  const apiResponses: ApiResponseObservation[] = [];
  context.on("request", (request) => {
    if (parseGitHubApiUrl(request.url()) == null) {
      return;
    }
    apiRequestCount += 1;
    if (request.headers().authorization != null) {
      apiRequestsWithAuthorization += 1;
    }
  });
  context.on("response", (response) => {
    const url = parseGitHubApiUrl(response.url());
    if (url == null) {
      return;
    }
    apiResponses.push({
      path: `${url.pathname}${url.search}`,
      status: response.status(),
      rateLimit: {
        limit: response.headers()["x-ratelimit-limit"] ?? null,
        remaining: response.headers()["x-ratelimit-remaining"] ?? null,
        reset: response.headers()["x-ratelimit-reset"] ?? null,
        resource: response.headers()["x-ratelimit-resource"] ?? null,
      },
    });
  });

  const page = await context.newPage();
  const targetUrl = `https://github.com/${liveRepository}/pulls?q=is%3Apr`;
  let responseStatus: number | null = null;
  let latestSnapshot: CanarySnapshot | null = null;

  try {
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    expect(serviceWorker.url()).toContain("chrome-extension://");

    const response = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    responseStatus = response?.status() ?? null;
    expect(responseStatus).toBe(200);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(targetUrl)}`));

    await expect
      .poll(
        async () => {
          latestSnapshot = await readCanarySnapshot(page);
          return latestSnapshot.rowCount;
        },
        {
          message: `expected live PR rows at ${targetUrl}`,
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);
    latestSnapshot = await readCanarySnapshot(page);
    const discoveredRowCount = latestSnapshot.rowCount;
    expect(discoveredRowCount).toBeGreaterThan(0);

    await expect
      .poll(
        async () => {
          latestSnapshot = await readCanarySnapshot(page);
          return latestSnapshot.pullNumbers.length;
        },
        {
          message: "expected every live PR row to expose a pull number",
          timeout: 15_000,
        },
      )
      .toBe(discoveredRowCount);

    await expect
      .poll(
        async () => {
          latestSnapshot = await readCanarySnapshot(page);
          return latestSnapshot.mountCount;
        },
        {
          message:
            "expected the extension to create a reviewer mount per PR row",
          timeout: 15_000,
        },
      )
      .toBe(discoveredRowCount);

    const verifiedSnapshot = await readCanarySnapshot(page);
    latestSnapshot = verifiedSnapshot;
    expect(new Set(verifiedSnapshot.pullNumbers).size).toBe(
      verifiedSnapshot.pullNumbers.length,
    );
    await expect
      .poll(
        () =>
          apiResponses.filter(
            (observation) =>
              observation.status >= 200 && observation.status < 300,
          ).length,
        {
          message:
            "expected the extension background to complete a public GitHub API request",
          timeout: 15_000,
        },
      )
      .toBeGreaterThan(0);
    expect(apiRequestCount).toBeGreaterThan(0);
    expect(apiRequestsWithAuthorization).toBe(0);
  } catch (error) {
    const screenshotPath = testInfo.outputPath("github-pr-list.png");
    const screenshotCaptured = await page
      .screenshot({ path: screenshotPath, fullPage: true })
      .then(
        () => true,
        () => false,
      );
    if (screenshotCaptured) {
      await testInfo.attach("github-pr-list.png", {
        path: screenshotPath,
        contentType: "image/png",
      });
    }
    await testInfo.attach("canary-diagnostics.json", {
      body: Buffer.from(
        JSON.stringify(
          {
            targetUrl,
            currentUrl: page.url(),
            responseStatus,
            snapshot: latestSnapshot,
            apiRequestCount,
            apiRequestsWithAuthorization,
            apiResponses,
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
    const pageHtml = await page.content().catch((contentError: unknown) => {
      return `Unable to capture page DOM: ${String(contentError)}`;
    });
    await testInfo.attach("github-pr-list.html", {
      body: Buffer.from(pageHtml),
      contentType: "text/html",
    });
    throw error;
  } finally {
    await context.close();
  }
});

async function readCanarySnapshot(page: Page): Promise<CanarySnapshot> {
  return page.locator(githubSelectors.row).evaluateAll(
    (rows, selectors) => {
      const pullNumbers: string[] = [];
      let mountCount = 0;

      for (const row of rows) {
        const rowId = row.getAttribute("id");
        const idMatch = rowId?.match(/issue_(\d+)/);
        let pullNumber = idMatch?.[1] ?? null;
        if (pullNumber == null) {
          for (const selector of selectors.pullLinkSelectors) {
            const href = row
              .querySelector<HTMLAnchorElement>(selector)
              ?.getAttribute("href");
            const hrefMatch = href?.match(/\/pull\/(\d+)/);
            if (hrefMatch != null) {
              pullNumber = hrefMatch[1];
              break;
            }
          }
        }
        if (pullNumber != null) {
          pullNumbers.push(pullNumber);
        }
        if (row.querySelector("[data-ghpsr-root]") != null) {
          mountCount += 1;
        }
      }

      return {
        rowCount: rows.length,
        pullNumbers,
        mountCount,
      };
    },
    { pullLinkSelectors: githubSelectors.pullLinkSelectors },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseGitHubApiUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.github.com"
      ? url
      : null;
  } catch {
    return null;
  }
}
