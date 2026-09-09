import { mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  chromium,
  expect,
  test,
  type JSHandle,
  type Page,
  type Response,
} from "@playwright/test";

import { githubSelectors } from "../../src/github/selectors";
import {
  collectLiveCanaryDomSnapshot,
  appendCanaryFailure,
  canaryStageArtifactFileName,
  captureSettledCanaryStage,
  createCanaryDiagnostics,
  createCanaryResponseObserver,
  evaluateLiveCanary,
  isClosedPullListFilter,
  isDifferentPullListPage,
  isTerminalCanaryDomSnapshot,
  sameCanaryPullNumberSet,
  type CanaryDomSnapshot,
  type CanaryDomCapture,
  type CanaryFailure,
  type CanaryNavigationObservation,
  type CanaryRepository,
  type CanaryResponseObserver,
} from "../helpers/live-github-canary";
import {
  attachCanaryDiagnostics,
  attachCanaryTextArtifact,
} from "../helpers/live-github-canary-artifacts";
import {
  findNativePullListLink,
  NavigationEvidenceError,
  type NavigationFailureCode,
} from "../helpers/live-github-canary-navigation";

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
      "required-pagination-link-unavailable",
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
    requireNavigationEvidence(
      page.url() !== previousUrl,
      "navigation-url-unchanged",
    );
    requireNavigationEvidence(
      !sameCanaryPullNumberSet(
        pageTwoDom.hostPullNumbers,
        initialDom.hostPullNumbers,
      ),
      "navigation-pull-set-unchanged",
    );
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
    requireNavigationEvidence(
      sameCanaryPullNumberSet(
        restoredDom.hostPullNumbers,
        initialDom.hostPullNumbers,
      ),
      "back-restore-set-mismatch",
    );
    documentResponse = { status: null };
    previousUrl = page.url();
    const restoredDocument = await page.evaluateHandle(() => document);
    phase = "navigation:D";
    navigation = {
      stage: "D",
      operation: "native-closed-filter-click",
      previousUrl,
      documentMaintained: null,
    };
    const filter = await findNativePullListLink(
      page,
      repository,
      isClosedPullListFilter,
      "required-filter-link-unavailable",
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
      operation: "native-closed-filter-click",
      targetUrl,
      previousUrl,
      responseStatus: documentResponse.status,
      documentMaintained: filterDocumentMaintained,
    });
    requireNavigationEvidence(
      page.url() !== previousUrl,
      "navigation-url-unchanged",
    );
    requireNavigationEvidence(
      !sameCanaryPullNumberSet(
        filteredDom.hostPullNumbers,
        restoredDom.hostPullNumbers,
      ),
      "navigation-pull-set-unchanged",
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
          operation: "native-closed-filter-click",
          previousUrl,
          documentMaintained: filterDocumentMaintained,
        },
      }),
    );
    expect(finalVerdict.ok).toBe(true);
  } catch (error) {
    const capture = await captureSettledCanaryStage({
      observer: apiObserver,
      readDom: () => readDomSnapshot(page, repository),
    }).then(
      ({ dom, api }) => ({
        dom,
        api,
        provenance: { source: "current-document" } satisfies CanaryDomCapture,
      }),
      () => ({
        dom: emptyDomSnapshot(),
        api: apiObserver.snapshot(),
        provenance: { source: "unavailable" } satisfies CanaryDomCapture,
      }),
    );
    const dom = capture.dom;
    const api = capture.api;
    const evaluatedVerdict = evaluateLiveCanary({ repository, dom, api });
    const captureVerdict =
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
    const verdict = appendCanaryFailure(
      captureVerdict,
      navigationFailureFor(error, phase),
    );
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
        canaryStageArtifactFileName(failedStage, true),
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
    await attachCanaryTextArtifact(
      testInfo,
      pageHtml,
      "github-pr-list.html",
      "text/html",
    );
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
  const { dom, api } = await captureSettledCanaryStage({
    observer: input.apiObserver,
    readDom: () => readDomSnapshot(input.page, input.repository),
  });
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
    canaryStageArtifactFileName(input.stage),
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

function requireNavigationEvidence(
  condition: boolean,
  code: Exclude<NavigationFailureCode, "navigation-stage-failed">,
): void {
  if (!condition) throw new NavigationEvidenceError(code);
}

function navigationFailureFor(error: unknown, phase: string): CanaryFailure | undefined {
  if (error instanceof NavigationEvidenceError) return error.failure;
  if (!/^navigation:[ABCD]$/.test(phase)) return undefined;
  return {
    owner: "observation",
    code: "navigation-stage-failed",
    pullNumber: null,
  };
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
