import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type JSHandle,
  type Page,
} from "@playwright/test";

import { githubSelectors } from "../../src/github/selectors";
import {
  collectLiveCanaryDomSnapshot,
  createCanaryResponseObserver,
  evaluateLiveCanary,
  type CanaryRepository,
} from "../helpers/live-github-canary";
import { createPullListFixtureHtml } from "../helpers/pull-list-fixtures";

const extensionPath = path.resolve(".output/chrome-mv3");
const repository: CanaryRepository = {
  owner: "hon454",
  repo: "github-pulls-show-reviewers",
};
const pullListUrl = `https://github.com/${repository.owner}/${repository.repo}/pulls`;
const apiBase = `https://api.github.com/repos/${repository.owner}/${repository.repo}`;

test("packaged canary oracle accepts rendered and empty reviewer outcomes", async () => {
  await withExtension(async (context) => {
    const observer = createCanaryResponseObserver({ repository });
    context.on("request", (request) => observer.observeRequest(request));
    context.on("response", (response) => observer.observeResponse(response));
    await routePullList(context, ["42", "43"]);
    await routeMetadata(context, [metadata(42, ["alice"]), metadata(43, [])]);
    await routeReviews(context, {
      "42": [
        {
          state: "APPROVED",
          submitted_at: "2026-09-01T00:00:00Z",
          user: { login: "bob" },
        },
      ],
      "43": [],
    });

    const page = await context.newPage();
    await page.goto(pullListUrl);
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(collectLiveCanaryDomSnapshot, {
          repository,
          productionRowSelector: githubSelectors.row,
        });
        return snapshot.rows.every(
          (row) => row.mountCount === 1 && row.loadingMountCount === 0,
        );
      })
      .toBe(true);
    await observer.settle();
    const dom = await page.evaluate(collectLiveCanaryDomSnapshot, {
      repository,
      productionRowSelector: githubSelectors.row,
    });
    const verdict = evaluateLiveCanary({
      repository,
      dom,
      api: observer.snapshot(),
    });

    expect(verdict).toMatchObject({
      ok: true,
      terminal: { success: 1, empty: 1, loading: 0, failure: 0 },
    });
    expect(verdict.samples).toHaveLength(2);
    expect(dom.activeFailureBannerCount).toBe(0);
    expect(observer.snapshot().apiRequestsWithAuthorization).toBe(0);
  });
});

test("packaged canary oracle rejects list success with failed review detail", async () => {
  await withExtension(async (context) => {
    const observer = createCanaryResponseObserver({ repository });
    context.on("request", (request) => observer.observeRequest(request));
    context.on("response", (response) => observer.observeResponse(response));
    await routePullList(context, ["42"]);
    await routeMetadata(context, [metadata(42, ["alice"])]);
    await context.route(`${apiBase}/pulls/42/reviews**`, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "fixture failure" }),
      });
    });

    const page = await context.newPage();
    await page.goto(pullListUrl);
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(collectLiveCanaryDomSnapshot, {
          repository,
          productionRowSelector: githubSelectors.row,
        });
        return snapshot.rows[0]?.loadingMountCount ?? 1;
      })
      .toBe(0);
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(collectLiveCanaryDomSnapshot, {
          repository,
          productionRowSelector: githubSelectors.row,
        });
        return snapshot.activeFailureBannerCount;
      })
      .toBe(1);
    await observer.settle();
    const dom = await page.evaluate(collectLiveCanaryDomSnapshot, {
      repository,
      productionRowSelector: githubSelectors.row,
    });
    const verdict = evaluateLiveCanary({
      repository,
      dom,
      api: observer.snapshot(),
    });

    expect(verdict.ok).toBe(false);
    expect(dom.activeFailureBannerCount).toBe(1);
    expect(verdict.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining(["api-server-error", "reviews-unavailable"]),
    );
  });
});

test("packaged canary rejects a selector-drift zero-row list with an unmatched PR link", async () => {
  await withExtension(async (context) => {
    const observer = createCanaryResponseObserver({ repository });
    context.on("request", (request) => observer.observeRequest(request));
    context.on("response", (response) => observer.observeResponse(response));
    await routePullListHtml(
      context,
      `<main><div class="js-navigation-container"><div class="new-row"><a href="/${repository.owner}/${repository.repo}/pull/42">PR</a></div></div></main>`,
    );

    const page = await context.newPage();
    await page.goto(pullListUrl);
    await observer.settle();
    const dom = await page.evaluate(collectLiveCanaryDomSnapshot, {
      repository,
      productionRowSelector: githubSelectors.row,
    });
    const verdict = evaluateLiveCanary({
      repository,
      dom,
      api: observer.snapshot(),
    });

    expect(dom).toMatchObject({
      pullListContainerFound: true,
      hostPullNumbers: [],
      unmatchedPullListLinkCount: 1,
    });
    expect(verdict.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "host-pull-row-unmatched" }),
      ]),
    );
    expect(verdict.ok).toBe(false);
  });
});

test("packaged canary rejects an orphan mount beside an otherwise settled current row", async () => {
  await withExtension(async (context) => {
    const observer = createCanaryResponseObserver({ repository });
    context.on("request", (request) => observer.observeRequest(request));
    context.on("response", (response) => observer.observeResponse(response));
    await routePullListHtml(
      context,
      `${createPullListFixtureHtml(["42"], repository).replace("</div>\n        </main>", "</div><span data-ghpsr-root></span>\n        </main>")}`,
    );
    await routeMetadata(context, [metadata(42, ["alice"])]);
    await routeReviews(context, { "42": [] });

    const page = await context.newPage();
    await page.goto(pullListUrl);
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(collectLiveCanaryDomSnapshot, {
          repository,
          productionRowSelector: githubSelectors.row,
        });
        return snapshot.rows[0]?.loadingMountCount ?? 1;
      })
      .toBe(0);
    await observer.settle();
    const dom = await page.evaluate(collectLiveCanaryDomSnapshot, {
      repository,
      productionRowSelector: githubSelectors.row,
    });
    const verdict = evaluateLiveCanary({
      repository,
      dom,
      api: observer.snapshot(),
    });

    expect(dom.orphanMountCount).toBe(1);
    expect(verdict.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "orphan-mount-present" }),
      ]),
    );
    expect(verdict.ok).toBe(false);
  });
});

test("packaged canary recovers one mount per current row across pagination, back, forward, and filter navigation", async () => {
  await withExtension(async (context) => {
    const initialUrl = `${pullListUrl}?q=is%3Apr`;
    const pageTwoUrl = `${pullListUrl}?q=is%3Apr&page=2`;
    const closedUrl = `${pullListUrl}?q=is%3Apr+is%3Aclosed`;
    const observer = createCanaryResponseObserver({ repository });
    context.on("request", (request) => observer.observeRequest(request));
    context.on("response", (response) => observer.observeResponse(response));
    await routeNavigablePullLists(context, {
      [initialUrl]: createPullListFixtureHtml(["42", "43"], repository, {
        paginationHref: pageTwoUrl,
        filterHref: closedUrl,
      }),
      [pageTwoUrl]: createPullListFixtureHtml(["44", "45"], repository),
      [closedUrl]: createPullListFixtureHtml(["46", "47"], repository),
    });
    await routeMetadata(
      context,
      [42, 43, 44, 45, 46, 47].map((number) =>
        metadata(number, number % 2 === 0 ? ["alice"] : []),
      ),
    );
    await routeReviews(context, {
      "42": [],
      "43": [],
      "44": [],
      "45": [],
      "46": [],
      "47": [],
    });

    const page = await context.newPage();
    await page.goto(initialUrl);
    await expectCurrentCanary(page, observer, ["42", "43"]);

    const initialDocument = await page.evaluateHandle(() => document);
    const pagination = page.locator("a[data-fixture-pagination]");
    await expect(pagination).toHaveAttribute("href", pageTwoUrl);
    await Promise.all([page.waitForURL(pageTwoUrl), pagination.click()]);
    expect(await documentWasMaintained(initialDocument)).toBe(false);
    await initialDocument.dispose();
    await expectCurrentCanary(page, observer, ["44", "45"]);

    const pageTwoDocument = await page.evaluateHandle(() => document);
    await Promise.all([page.waitForURL(initialUrl), page.goBack()]);
    expect(await documentWasMaintained(pageTwoDocument)).toBe(false);
    await pageTwoDocument.dispose();
    await expectCurrentCanary(page, observer, ["42", "43"]);

    const restoredDocument = await page.evaluateHandle(() => document);
    await Promise.all([page.waitForURL(pageTwoUrl), page.goForward()]);
    expect(await documentWasMaintained(restoredDocument)).toBe(false);
    await restoredDocument.dispose();
    await expectCurrentCanary(page, observer, ["44", "45"]);

    const forwardDocument = await page.evaluateHandle(() => document);
    await Promise.all([page.waitForURL(initialUrl), page.goBack()]);
    expect(await documentWasMaintained(forwardDocument)).toBe(false);
    await forwardDocument.dispose();
    await expectCurrentCanary(page, observer, ["42", "43"]);

    const restoredAgainDocument = await page.evaluateHandle(() => document);
    const filter = page.locator("a[data-fixture-filter]");
    await expect(filter).toHaveAttribute("href", closedUrl);
    await Promise.all([page.waitForURL(closedUrl), filter.click()]);
    expect(await documentWasMaintained(restoredAgainDocument)).toBe(false);
    await restoredAgainDocument.dispose();
    await expectCurrentCanary(page, observer, ["46", "47"]);
    expect(observer.snapshot().apiRequestsWithAuthorization).toBe(0);
  });
});

async function withExtension(
  run: (context: BrowserContext) => Promise<void>,
): Promise<void> {
  const profile = await mkdtemp(
    path.join(os.tmpdir(), "ghpsr-canary-fixture-"),
  );
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    locale: "en-US",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    expect(worker.url()).toContain("chrome-extension://");
    await closeInstallPage(context);
    await run(context);
  } finally {
    await context.close();
  }
}

async function closeInstallPage(context: BrowserContext): Promise<void> {
  const closePages = () =>
    Promise.all(
      context
        .pages()
        .filter((page) => page.url().startsWith("chrome-extension://"))
        .map((page) => page.close().catch(() => undefined)),
    );
  await closePages();
  await context
    .waitForEvent("page", { timeout: 1_000 })
    .then(async () => closePages())
    .catch(() => undefined);
}

async function routePullList(
  context: BrowserContext,
  pullNumbers: readonly string[],
): Promise<void> {
  await context.route(pullListUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: createPullListFixtureHtml(pullNumbers, repository),
    });
  });
}

async function routePullListHtml(
  context: BrowserContext,
  body: string,
): Promise<void> {
  await context.route(pullListUrl, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body });
  });
}

async function routeNavigablePullLists(
  context: BrowserContext,
  pages: Record<string, string>,
): Promise<void> {
  await context.route(`${pullListUrl}**`, async (route) => {
    const html = pages[route.request().url()];
    if (html == null)
      throw new Error(
        `unexpected fixture pull-list URL: ${route.request().url()}`,
      );
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: html,
    });
  });
}

async function routeMetadata(
  context: BrowserContext,
  payload: object,
): Promise<void> {
  await context.route(new RegExp(`^${apiBase}/pulls\\?`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
}

async function routeReviews(
  context: BrowserContext,
  payloads: Record<string, object>,
): Promise<void> {
  await context.route(
    new RegExp(`^${apiBase}/pulls/(\\d+)/reviews`),
    async (route) => {
      const pullNumber = /\/pulls\/(\d+)\/reviews/.exec(
        route.request().url(),
      )?.[1];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          pullNumber == null ? [] : (payloads[pullNumber] ?? []),
        ),
      });
    },
  );
}

function metadata(number: number, requestedUsers: string[]): object {
  return {
    number,
    user: { login: "author" },
    requested_reviewers: requestedUsers.map((login) => ({ login })),
    requested_teams: [],
  };
}

async function expectCurrentCanary(
  page: Page,
  observer: ReturnType<typeof createCanaryResponseObserver>,
  expectedPullNumbers: string[],
): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await page.evaluate(collectLiveCanaryDomSnapshot, {
        repository,
        productionRowSelector: githubSelectors.row,
      });
      return snapshot.rows.every(
        (row) => row.mountCount === 1 && row.loadingMountCount === 0,
      );
    })
    .toBe(true);
  await observer.settle();
  const dom = await page.evaluate(collectLiveCanaryDomSnapshot, {
    repository,
    productionRowSelector: githubSelectors.row,
  });
  expect(dom.hostPullNumbers).toEqual(expectedPullNumbers);
  expect(dom.rows.map((row) => row.mountCount)).toEqual(
    expectedPullNumbers.map(() => 1),
  );
  expect(
    evaluateLiveCanary({ repository, dom, api: observer.snapshot() }).ok,
  ).toBe(true);
}

async function documentWasMaintained(
  documentHandle: JSHandle<Document>,
): Promise<boolean> {
  return documentHandle
    .evaluate((previousDocument) => previousDocument === document)
    .catch(() => false);
}
