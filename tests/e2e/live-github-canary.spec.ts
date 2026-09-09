import { mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  chromium,
  expect,
  test,
  type JSHandle,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";

import { githubSelectors } from "../../src/github/selectors";
import {
  collectLiveCanaryDomSnapshot,
  createCanaryDiagnostics,
  createCanaryResponseObserver,
  evaluateLiveCanary,
  isDifferentPullListPage,
  isTerminalCanaryDomSnapshot,
  type CanaryDomSnapshot,
  type CanaryDomCapture,
  type CanaryNavigationObservation,
  type CanaryRepository,
  type CanaryResponseObserver,
} from "../helpers/live-github-canary";
import { attachCanaryDiagnostics } from "../helpers/live-github-canary-artifacts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../..");
const extensionPath = path.join(projectRoot, ".output/chrome-mv3");
const liveRepository = process.env.LIVE_GITHUB_REPOSITORY ?? "cli/cli";

test("verifies reviewer recovery across live pull-list navigation", async ({
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
  let documentResponse = { status: null as number | null };
  let previousUrl: string | null = null;
  let navigation: CanaryNavigationObservation | undefined;

  try {
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    expect(serviceWorker.url()).toContain("chrome-extension://");

    phase = "navigation:A";
    navigation = {
      stage: "A",
      operation: "initial-all-state",
      previousUrl: null,
      documentMaintained: null,
    };
    const response = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    documentResponse.status = response?.status() ?? null;
    expect(documentResponse.status).toBe(200);
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(targetUrl)}`));
    const initialDom = await assertNavigationStage({
      page,
      testInfo,
      apiObserver,
      repository,
      stage: "A",
      operation: "initial-all-state",
      targetUrl,
      previousUrl: null,
      responseStatus: documentResponse.status,
      documentMaintained: null,
    });
    documentResponse = { status: null };
    previousUrl = page.url();
    const paginationCurrentUrl = previousUrl;
    const initialDocument = await page.evaluateHandle(() => document);
    phase = "navigation:B";
    navigation = {
      stage: "B",
      operation: "native-pagination-click",
      previousUrl,
      documentMaintained: null,
    };
    const pagination = await findNativePullListLink(
      page,
      repository,
      (url) => isDifferentPullListPage(url, paginationCurrentUrl),
    );
    await observeMainDocumentResponse(
      page,
      pagination.url,
      documentResponse,
      async () => {
        await Promise.all([
          page.waitForURL(pagination.url, { timeout: 60_000 }),
          pagination.locator.click(),
        ]);
      },
    );
    const pageTwoDocumentMaintained =
      await documentWasMaintained(initialDocument);
    navigation.documentMaintained = pageTwoDocumentMaintained;
    await initialDocument.dispose();
    const pageTwoDom = await assertNavigationStage({
      page,
      testInfo,
      apiObserver,
      repository,
      stage: "B",
      operation: "native-pagination-click",
      targetUrl,
      previousUrl,
      responseStatus: documentResponse.status,
      documentMaintained: pageTwoDocumentMaintained,
    });
    expect(page.url()).not.toBe(previousUrl);
    expect(pageTwoDom.hostPullNumbers).not.toEqual(initialDom.hostPullNumbers);
    documentResponse = { status: null };
    previousUrl = page.url();
    const pageTwoDocument = await page.evaluateHandle(() => document);
    phase = "navigation:C";
    navigation = {
      stage: "C",
      operation: "browser-back",
      previousUrl,
      documentMaintained: null,
    };
    await observeMainDocumentResponse(
      page,
      targetUrl,
      documentResponse,
      async () => {
        await Promise.all([
          page.waitForURL(targetUrl, { timeout: 60_000 }),
          page.goBack({ waitUntil: "domcontentloaded", timeout: 60_000 }),
        ]);
      },
    );
    const restoredDocumentMaintained =
      await documentWasMaintained(pageTwoDocument);
    navigation.documentMaintained = restoredDocumentMaintained;
    await pageTwoDocument.dispose();
    const restoredDom = await assertNavigationStage({
      page,
      testInfo,
      apiObserver,
      repository,
      stage: "C",
      operation: "browser-back",
      targetUrl,
      previousUrl,
      responseStatus: documentResponse.status,
      documentMaintained: restoredDocumentMaintained,
    });
    expect(restoredDom.hostPullNumbers).toEqual(initialDom.hostPullNumbers);
    documentResponse = { status: null };
    previousUrl = page.url();
    const restoredDocument = await page.evaluateHandle(() => document);
    phase = "navigation:D";
    navigation = {
      stage: "D",
      operation: "native-open-closed-filter-click",
      previousUrl,
      documentMaintained: null,
    };
    const filter = await findNativePullListLink(page, repository, (url) =>
      /(?:^|\s)is:(?:open|closed)(?:\s|$)/i.test(
        url.searchParams.get("q") ?? "",
      ),
    );
    await observeMainDocumentResponse(
      page,
      filter.url,
      documentResponse,
      async () => {
        await Promise.all([
          page.waitForURL(filter.url, { timeout: 60_000 }),
          filter.locator.click(),
        ]);
      },
    );
    const filterDocumentMaintained =
      await documentWasMaintained(restoredDocument);
    navigation.documentMaintained = filterDocumentMaintained;
    await restoredDocument.dispose();
    const filteredDom = await assertNavigationStage({
      page,
      testInfo,
      apiObserver,
      repository,
      stage: "D",
      operation: "native-open-closed-filter-click",
      targetUrl,
      previousUrl,
      responseStatus: documentResponse.status,
      documentMaintained: filterDocumentMaintained,
    });
    expect(page.url()).not.toBe(previousUrl);
    expect(filteredDom.hostPullNumbers).not.toEqual(
      restoredDom.hostPullNumbers,
    );

    await apiObserver.settle();
    const finalApi = apiObserver.snapshot();
    const finalVerdict = evaluateLiveCanary({
      repository,
      dom: filteredDom,
      api: finalApi,
    });
    await attachCanaryDiagnostics(
      testInfo,
      createCanaryDiagnostics({
        phase: "navigation-complete",
        repository,
        targetUrl,
        currentUrl: page.url(),
        responseStatus: documentResponse.status,
        dom: filteredDom,
        api: finalApi,
        verdict: finalVerdict,
        navigation: {
          stage: "D",
          operation: "native-open-closed-filter-click",
          previousUrl,
          documentMaintained: filterDocumentMaintained,
        },
      }),
    );
    expect(finalVerdict.ok).toBe(true);
  } catch (error) {
    await apiObserver.settle();
    const capture = await readDomSnapshot(page, repository).then(
      (dom) => ({
        dom,
        provenance: { source: "current-document" } satisfies CanaryDomCapture,
      }),
      () => ({
        dom: emptyDomSnapshot(),
        provenance: { source: "unavailable" } satisfies CanaryDomCapture,
      }),
    );
    const dom = capture.dom;
    const api = apiObserver.snapshot();
    const evaluatedVerdict = evaluateLiveCanary({ repository, dom, api });
    const verdict =
      capture.provenance.source === "current-document"
        ? evaluatedVerdict
        : {
            ...evaluatedVerdict,
            ok: false,
            failures: [
              ...evaluatedVerdict.failures,
              {
                owner: "observation" as const,
                code: "current-dom-capture-failed",
                pullNumber: null,
              },
            ],
          };
    const diagnostics = createCanaryDiagnostics({
      phase,
      repository,
      targetUrl,
      currentUrl: page.url(),
      responseStatus: documentResponse.status,
      dom,
      api,
      verdict,
      domCapture: capture.provenance,
      ...(navigation == null ? {} : { navigation }),
    });
    const failedStage = /^navigation:([ABCD])$/.exec(phase)?.[1];
    if (failedStage != null)
      await attachCanaryDiagnostics(
        testInfo,
        diagnostics,
        `canary-navigation-${failedStage}.json`,
      );
    await attachCanaryDiagnostics(testInfo, diagnostics);

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

async function assertNavigationStage(input: {
  page: Page;
  testInfo: Parameters<typeof attachCanaryDiagnostics>[0];
  apiObserver: CanaryResponseObserver;
  repository: CanaryRepository;
  stage: "A" | "B" | "C" | "D";
  operation: string;
  targetUrl: string;
  previousUrl: string | null;
  responseStatus: number | null;
  documentMaintained: boolean | null;
}): Promise<CanaryDomSnapshot> {
  await expect
    .poll(
      async () => {
        const dom = await readDomSnapshot(input.page, input.repository);
        return isTerminalCanaryDomSnapshot(dom);
      },
      {
        message: `expected terminal reviewer mounts at navigation stage ${input.stage}`,
        timeout: 30_000,
      },
    )
    .toBe(true);
  await input.apiObserver.settle();
  const dom = await readDomSnapshot(input.page, input.repository);
  const api = input.apiObserver.snapshot();
  const verdict = evaluateLiveCanary({
    repository: input.repository,
    dom,
    api,
  });
  const navigation: CanaryNavigationObservation = {
    stage: input.stage,
    operation: input.operation,
    previousUrl: input.previousUrl,
    documentMaintained: input.documentMaintained,
  };
  const diagnosticsPath = await attachCanaryDiagnostics(
    input.testInfo,
    createCanaryDiagnostics({
      phase: `navigation:${input.stage}`,
      repository: input.repository,
      targetUrl: input.targetUrl,
      currentUrl: input.page.url(),
      responseStatus: input.responseStatus,
      dom,
      api,
      verdict,
      navigation,
    }),
    `canary-navigation-${input.stage}.json`,
  );
  const persisted = JSON.parse(await readFile(diagnosticsPath, "utf8")) as {
    navigation?: CanaryNavigationObservation;
    host?: { pullNumbers?: string[] };
    terminal?: unknown;
    samples?: unknown;
    api?: { endpoints?: unknown };
  };
  expect(persisted.navigation).toEqual(navigation);
  expect(persisted.host?.pullNumbers).toEqual(dom.hostPullNumbers);
  expect(persisted.terminal).toEqual(verdict.terminal);
  expect(persisted.samples).toEqual(verdict.samples);
  expect(persisted.api?.endpoints).toEqual(api.endpoints);
  expect(
    verdict.ok,
    `live reviewer verdict failed at ${input.stage}: ${JSON.stringify(verdict.failures)}`,
  ).toBe(true);
  return dom;
}

async function findNativePullListLink(
  page: Page,
  repository: CanaryRepository,
  predicate: (url: URL) => boolean,
): Promise<{ url: string; locator: Locator }> {
  const links = page.locator("main a[href]");
  const count = await links.count();
  for (let index = 0; index < count; index += 1) {
    const locator = links.nth(index);
    const href = await locator.getAttribute("href");
    if (href == null) continue;
    const url = new URL(href, page.url());
    if (
      url.origin !== "https://github.com" ||
      url.pathname.toLowerCase() !==
        `/${repository.owner}/${repository.repo}/pulls`.toLowerCase() ||
      !predicate(url)
    )
      continue;
    return { url: url.toString(), locator };
  }
  throw new Error(
    "required native same-repository pull-list link is unavailable",
  );
}

async function documentWasMaintained(
  documentHandle: JSHandle<Document>,
): Promise<boolean> {
  return documentHandle
    .evaluate((previousDocument) => previousDocument === document)
    .catch(() => false);
}

function readDomSnapshot(
  page: Page,
  repository: CanaryRepository,
): Promise<CanaryDomSnapshot> {
  return page.evaluate(collectLiveCanaryDomSnapshot, {
    repository,
    productionRowSelector: githubSelectors.row,
  });
}

async function observeMainDocumentResponse(
  page: Page,
  targetUrl: string,
  observation: { status: number | null },
  action: () => Promise<void>,
): Promise<void> {
  const target = new URL(targetUrl);
  const onResponse = (response: Response) => {
    if (
      !response.request().isNavigationRequest() ||
      response.request().frame() !== page.mainFrame()
    )
      return;
    const observed = new URL(response.url());
    if (
      observed.origin === target.origin &&
      observed.pathname === target.pathname &&
      observed.search === target.search
    )
      observation.status = response.status();
  };
  page.on("response", onResponse);
  try {
    await action();
  } finally {
    page.off("response", onResponse);
  }
}

function emptyDomSnapshot(): CanaryDomSnapshot {
  return {
    mainFound: false,
    pullListContainerFound: false,
    hostEmptySignalFound: false,
    hostListLoading: false,
    unmatchedPullListLinkCount: 0,
    orphanMountCount: 0,
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
