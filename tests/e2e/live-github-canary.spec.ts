import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { chromium, expect, test, type Page } from "@playwright/test";

import { githubSelectors } from "../../src/github/selectors";
import {
  collectLiveCanaryDomSnapshot,
  createCanaryDiagnostics,
  createCanaryResponseObserver,
  evaluateLiveCanary,
  type CanaryDomSnapshot,
  type CanaryRepository,
} from "../helpers/live-github-canary";
import { attachCanaryDiagnostics } from "../helpers/live-github-canary-artifacts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../..");
const extensionPath = path.join(projectRoot, ".output/chrome-mv3");
const liveRepository = process.env.LIVE_GITHUB_REPOSITORY ?? "cli/cli";

test("verifies rendered reviewer outcomes on live GitHub", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  expect(liveRepository).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const [owner, repo] = liveRepository.split("/");
  const repository: CanaryRepository = { owner, repo };
  const targetUrl = `https://github.com/${liveRepository}/pulls?q=is%3Apr`;
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "ghpsr-live-canary-"),
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    locale: "en-US",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  const apiObserver = createCanaryResponseObserver({ repository });
  context.on("request", (request) => apiObserver.observeRequest(request));
  context.on("response", (response) => apiObserver.observeResponse(response));

  const page = await context.newPage();
  let phase = "service-worker";
  let responseStatus: number | null = null;
  let latestDom: CanaryDomSnapshot | null = null;
  let diagnosticsAttached = false;

  try {
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    expect(serviceWorker.url()).toContain("chrome-extension://");

    phase = "navigation";
    const response = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    responseStatus = response?.status() ?? null;
    expect(responseStatus).toBe(200);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(targetUrl)}`));

    phase = "host-row-discovery";
    await expect
      .poll(
        async () => {
          latestDom = await readDomSnapshot(page, repository);
          return latestDom.hostPullNumbers.length;
        },
        {
          message: `expected independent live PR-link rows at ${targetUrl}`,
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);

    phase = "reviewer-terminal-state";
    await expect
      .poll(
        async () => {
          latestDom = await readDomSnapshot(page, repository);
          return latestDom.rows.every(
            (row) => row.mountCount === 1 && row.loadingMountCount === 0,
          );
        },
        {
          message:
            "expected one non-loading reviewer mount for every independent host row",
          timeout: 30_000,
        },
      )
      .toBe(true);

    phase = "response-body-settlement";
    await apiObserver.settle();
    latestDom = await readDomSnapshot(page, repository);
    const api = apiObserver.snapshot();
    const verdict = evaluateLiveCanary({ repository, dom: latestDom, api });
    const diagnostics = createCanaryDiagnostics({
      phase: "assertion",
      repository,
      targetUrl,
      currentUrl: page.url(),
      responseStatus,
      dom: latestDom,
      api,
      verdict,
    });
    await attachCanaryDiagnostics(testInfo, diagnostics);
    diagnosticsAttached = true;
    expect(
      verdict.ok,
      `live reviewer verdict failed: ${JSON.stringify(verdict.failures)}`,
    ).toBe(true);
  } catch (error) {
    await apiObserver.settle();
    latestDom ??= await readDomSnapshot(page, repository).catch(() => null);
    const dom = latestDom ?? emptyDomSnapshot();
    const api = apiObserver.snapshot();
    const verdict = evaluateLiveCanary({ repository, dom, api });
    if (!diagnosticsAttached) {
      await attachCanaryDiagnostics(
        testInfo,
        createCanaryDiagnostics({
          phase,
          repository,
          targetUrl,
          currentUrl: page.url(),
          responseStatus,
          dom,
          api,
          verdict,
        }),
      );
    }

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
    const pageHtml = await page.content().catch((contentError: unknown) => {
      return `Unable to capture page DOM: ${String(contentError)}`;
    });
    await testInfo.attach("github-pr-list.html", {
      body: Buffer.from(pageHtml),
      contentType: "text/html",
    });
    throw error;
  } finally {
    await apiObserver.settle();
    await context.close();
  }
});

function readDomSnapshot(
  page: Page,
  repository: CanaryRepository,
): Promise<CanaryDomSnapshot> {
  return page.evaluate(collectLiveCanaryDomSnapshot, {
    repository,
    productionRowSelector: githubSelectors.row,
  });
}

function emptyDomSnapshot(): CanaryDomSnapshot {
  return {
    mainFound: false,
    challengeDetected: false,
    ignoredPullLinkCount: 0,
    activeFailureBannerCount: 0,
    hostPullNumbers: [],
    productionPullNumbers: [],
    rows: [],
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
