import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type CDPSession,
} from "@playwright/test";
import { createPullListFixtureHtml } from "../helpers/pull-list-fixtures";

const extension = path.resolve(".output/chrome-mv3");
const repository = { owner: "octo", repo: "repo" };
const ACCESS = "SYNTHETIC_ACCESS_175";
const REFRESH = "SYNTHETIC_REFRESH_175";
const DEVICE = "SYNTHETIC_DEVICE_175";
type NativeChrome = typeof browser;
type Audit = {
  violations: number;
  storageReads: number;
  storageListeners: number;
  observed: number;
  waiting: Array<{ flowId: string; expiresAt: number; interval: number }>;
};
type AuditedWindow = typeof globalThis & {
  chrome: NativeChrome;
  boundaryAudit: Audit;
};

async function launch(
  profile: string,
  packagePath = extension,
  upgrade = false,
) {
  return chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [
      ...(upgrade ? ["--enable-unsafe-extension-debugging"] : []),
      `--disable-extensions-except=${packagePath}`,
      `--load-extension=${packagePath}`,
    ],
  });
}
async function installed(context: BrowserContext, expectInstallPage = true) {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const url = `chrome-extension://${new URL(worker.url()).host}/options.html`;
  if (expectInstallPage)
    await expect
      .poll(() =>
        context
          .pages()
          .find((page) => page.url() === url)
          ?.url(),
      )
      .toBe(url);
  const options =
    context.pages().find((page) => page.url() === url) ??
    (await context.newPage());
  if (options.url() !== url) await options.goto(url);
  await expect(options.getByTestId("language-select")).toBeVisible();
  return { worker, options, url };
}

async function installOptionsAudit(context: BrowserContext) {
  await context.addInitScript(() => {
    if (location.protocol !== "chrome-extension:") return;
    const scope = globalThis as AuditedWindow;
    const api = scope.chrome;
    const audit: Audit = {
      violations: 0,
      storageReads: 0,
      storageListeners: 0,
      observed: 0,
      waiting: [],
    };
    scope.boundaryAudit = audit;
    const forbidden = new Set([
      "token",
      "accessToken",
      "access_token",
      "refreshToken",
      "refresh_token",
      "deviceCode",
      "device_code",
      "oldValue",
      "newValue",
      "headers",
      "authorization",
    ]);
    function inspect(value: unknown): boolean {
      if (typeof value === "string")
        return /SYNTHETIC_(ACCESS|REFRESH|DEVICE)_175/.test(value);
      if (Array.isArray(value)) return value.some(inspect);
      if (!value || typeof value !== "object") return false;
      return Object.entries(value).some(
        ([key, item]) => forbidden.has(key) || inspect(item),
      );
    }
    function observe(value: unknown) {
      audit.observed++;
      if (inspect(value)) audit.violations++;
      const data =
        (value as { data?: unknown; progress?: unknown } | undefined)?.data ??
        (value as { progress?: unknown } | undefined)?.progress;
      if (
        data &&
        typeof data === "object" &&
        "phase" in data &&
        data.phase === "waiting"
      ) {
        const waiting = data as unknown as {
          flowId: string;
          expiresAt: number;
          interval: number;
        };
        audit.waiting.push({
          flowId: waiting.flowId,
          expiresAt: waiting.expiresAt,
          interval: waiting.interval,
        });
      }
      return value;
    }
    const send = api.runtime.sendMessage.bind(api.runtime);
    api.runtime.sendMessage = ((...args: unknown[]) => {
      // Cover promise and callback API adapters without changing message contents.
      const last = args.at(-1);
      if (typeof last === "function")
        args[args.length - 1] = (value: unknown) => last(observe(value));
      const result = (send as (...args: unknown[]) => unknown)(...args);
      return result && typeof result === "object" && "then" in result
        ? (result as Promise<unknown>).then(observe)
        : result;
    }) as typeof api.runtime.sendMessage;
    const connect = api.runtime.connect.bind(api.runtime);
    api.runtime.connect = ((...args: Parameters<typeof connect>) => {
      const port = connect(...args);
      port.onMessage.addListener(observe);
      return port;
    }) as typeof api.runtime.connect;
    const read = api.storage.local.get.bind(api.storage.local);
    api.storage.local.get = ((...args: Parameters<typeof read>) => {
      audit.storageReads++;
      return read(...args);
    }) as typeof api.storage.local.get;
    const listen = api.storage.onChanged.addListener.bind(
      api.storage.onChanged,
    );
    api.storage.onChanged.addListener = ((
      ...args: Parameters<typeof listen>
    ) => {
      audit.storageListeners++;
      return listen(...args);
    }) as typeof api.storage.onChanged.addListener;
  });
}
async function audit(options: Page) {
  return options.evaluate(() => (globalThis as AuditedWindow).boundaryAudit);
}
async function assertAudit(options: Page) {
  await expect
    .poll(async () => (await audit(options))?.observed)
    .toBeGreaterThan(0);
  const value = await audit(options);
  expect({
    violations: value.violations,
    storageReads: value.storageReads,
    storageListeners: value.storageListeners,
  }).toEqual({ violations: 0, storageReads: 0, storageListeners: 0 });
  return value;
}

async function contentContext(
  context: BrowserContext,
  page: Page,
  url: string,
) {
  const session = await context.newCDPSession(page);
  const contexts = new Set<number>();
  session.on("Runtime.executionContextCreated", ({ context: execution }) => {
    if (!execution.auxData?.isDefault) contexts.add(execution.id);
  });
  session.on("Runtime.executionContextDestroyed", ({ executionContextId }) =>
    contexts.delete(executionContextId),
  );
  await session.send("Runtime.enable");
  await page.goto(url);
  let contextId: number | undefined;
  await expect
    .poll(async () => {
      for (const candidate of contexts) {
        const result = await session
          .send("Runtime.evaluate", {
            contextId: candidate,
            expression: "typeof chrome !== 'undefined' && !!chrome.runtime?.id",
            returnByValue: true,
          })
          .catch(() => null);
        if (result?.result.value === true) {
          contextId = candidate;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  return { session, contextId: contextId! };
}
async function evaluateContent<T>(
  input: { session: CDPSession; contextId: number },
  expression: string,
): Promise<T> {
  const value = await input.session.send("Runtime.evaluate", {
    contextId: input.contextId,
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  expect(value.exceptionDetails).toBeUndefined();
  return value.result.value as T;
}
const storageDenial = `(async () => {
  let readDenied = false, writeDenied = false;
  try { await chrome.storage.local.get(null); } catch { readDenied = true; }
  try { await chrome.storage.local.set({ harmlessContentProbe: true }); } catch { writeDenied = true; }
  const snapshot = await chrome.runtime.sendMessage({ type: 'getUISnapshot' });
  const forbidden = await chrome.runtime.sendMessage({ type: 'startDeviceFlow', attemptId: 'content-forbidden-attempt' });
  const unsafe = /SYNTHETIC_(ACCESS|REFRESH|DEVICE)_175|"(?:accessToken|refreshToken|deviceCode|oldValue|newValue|token)"/.test(JSON.stringify(snapshot));
  return { readDenied, writeDenied, snapshotSafe: !unsafe, accountListHidden: snapshot.data?.accounts === null, capabilityForbidden: forbidden.error === 'forbidden' };
})()`;
const denied = {
  readDenied: true,
  writeDenied: true,
  snapshotSafe: true,
  accountListHidden: true,
  capabilityForbidden: true,
};

function fixture() {
  return createPullListFixtureHtml(["42"], repository);
}
async function routeFixture(context: BrowserContext) {
  await context.route("https://github.com/octo/repo/pulls", (route) =>
    route.fulfill({ contentType: "text/html", body: fixture() }),
  );
}
function installation() {
  return {
    id: 10,
    account: { login: "octo", type: "Organization", avatar_url: null },
    repository_selection: "all",
  };
}

// All remote responses are synthetic. Request provenance records never contain
// headers, request bodies, credentials or raw response payloads.
test("packaged sign-in, diagnostics, refresh and two-tab settings cross only a token-free boundary", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  const profile = await mkdtemp(path.join(os.tmpdir(), "ghpsr-boundary-"));
  const context = await launch(profile);
  const provenance: Array<{ path: string; serviceWorker: boolean }> = [];
  try {
    await installOptionsAudit(context);
    await context.route("https://**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "github.com" && url.pathname === "/octo/repo/pulls")
        return route.fulfill({ contentType: "text/html", body: fixture() });
      if (
        url.hostname !== "api.github.com" &&
        !url.pathname.startsWith("/login/")
      )
        return route.abort();
      provenance.push({
        path: url.pathname,
        serviceWorker: route.request().serviceWorker() != null,
      });
      if (url.pathname === "/login/device/code")
        return route.fulfill({
          json: {
            device_code: DEVICE,
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          },
        });
      if (url.pathname === "/login/oauth/access_token")
        return route.fulfill({
          json: {
            access_token: ACCESS,
            refresh_token: REFRESH,
            token_type: "bearer",
            expires_in: 28800,
            refresh_token_expires_in: 15552000,
          },
        });
      if (url.pathname === "/user")
        return route.fulfill({ json: { login: "octocat", avatar_url: null } });
      if (url.pathname === "/user/installations")
        return route.fulfill({
          json: { total_count: 1, installations: [installation()] },
        });
      if (url.pathname === "/repos/octo/repo/pulls")
        return route.fulfill({
          json: [
            {
              number: 42,
              user: { login: "author" },
              requested_reviewers: [{ login: "alice" }],
              requested_teams: [],
            },
          ],
        });
      if (url.pathname === "/repos/octo/repo/pulls/42")
        return route.fulfill({
          json: {
            number: 42,
            user: { login: "author" },
            requested_reviewers: [{ login: "alice" }],
            requested_teams: [],
          },
        });
      if (url.pathname.endsWith("/reviews") || url.pathname.endsWith("/events"))
        return route.fulfill({ json: [] });
      return route.abort();
    });
    const { options, url } = await installed(context);
    // Reload to guarantee instrumentation preceded every application module.
    await options.reload();
    await expect(options.getByTestId("accounts-add")).toBeVisible();
    const second = await context.newPage();
    await second.goto(url);
    const page = await context.newPage();
    const content = await contentContext(
      context,
      page,
      "https://github.com/octo/repo/pulls",
    );
    expect(await evaluateContent(content, storageDenial)).toEqual(denied);
    await options.getByTestId("accounts-add").click();
    await expect(options.getByTestId("device-user-code")).toHaveText(
      "ABCD-EFGH",
    );
    await expect(options.getByTestId("account-card-octocat")).toBeVisible();
    await expect(second.getByTestId("account-card-octocat")).toBeVisible();
    await expect(page.locator('a.ghpsr-avatar[title*="@alice"]')).toHaveCount(
      1,
    );
    await options.getByTestId("diagnostics-repo").fill("octo/repo");
    await options.getByTestId("diagnostics-matched").click();
    await expect(options.getByTestId("diagnostics-status")).toContainText(
      "both passed with the saved token",
    );
    await options
      .getByRole("button", { name: "Refresh installations", exact: true })
      .click();
    await expect(
      options.getByRole("button", {
        name: "Refresh installations",
        exact: true,
      }),
    ).toBeEnabled();
    // Count only OAuth/API work; rerendered avatar requests are presentation.
    const beforePresentation = provenance.length;
    await second.getByTestId("prefs-show-reviewer-name").click();
    await expect(second.getByTestId("prefs-show-reviewer-name")).toBeChecked();
    await second.getByTestId("prefs-open-pulls-only").click();
    await expect(second.getByTestId("prefs-open-pulls-only")).not.toBeChecked();
    for (const language of ["ko", "ja", "zh_CN", "zh_TW", "en"]) {
      await second.getByTestId("language-select").selectOption(language);
      await expect(options.locator("html")).toHaveAttribute(
        "lang",
        language.replace("_", "-"),
      );
      await expect(page.locator(".ghpsr-root")).toHaveAttribute(
        "lang",
        language.replace("_", "-"),
      );
    }
    await expect(page.locator("a.ghpsr-pill")).toHaveCount(1);
    expect(
      new URL(
        (await page.locator("a.ghpsr-pill").getAttribute("href")) ?? "",
      ).searchParams.get("q"),
    ).toBe("is:pr review-requested:alice");
    expect(provenance.length).toBe(beforePresentation);
    expect(provenance.every((request) => request.serviceWorker)).toBe(true);
    expect(
      provenance.filter((request) => request.path === "/user/installations"),
    ).toHaveLength(2);
    expect(await evaluateContent(content, storageDenial)).toEqual(denied);
    await assertAudit(options);
    await assertAudit(second);
    await testInfo.attach("boundary-provenance", {
      body: JSON.stringify({
        provenance,
        contentStorageDenied: true,
        rawUIStorageReads: 0,
        rawUIStorageSubscriptions: 0,
      }),
      contentType: "application/json",
    });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("restarts the actual MV3 worker between polling ticks while retaining flow ID, slow-down and deadline", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  test.setTimeout(30_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "ghpsr-worker-flow-"));
  const context = await launch(profile);
  let polls = 0;
  try {
    await installOptionsAudit(context);
    await context.route("https://**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/login/device/code")
        return route.fulfill({
          json: {
            device_code: DEVICE,
            user_code: "WORK-ERID",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          },
        });
      if (url.pathname === "/login/oauth/access_token") {
        polls++;
        return route.fulfill({
          json:
            polls === 1
              ? { error: "slow_down" }
              : {
                  access_token: ACCESS,
                  refresh_token: REFRESH,
                  token_type: "bearer",
                  expires_in: 28800,
                },
        });
      }
      if (url.pathname === "/user")
        return route.fulfill({ json: { login: "restored", avatar_url: null } });
      if (url.pathname === "/user/installations")
        return route.fulfill({ json: { total_count: 0, installations: [] } });
      return route.abort();
    });
    const { options, worker } = await installed(context);
    await options.reload();
    await expect(options.getByTestId("accounts-add")).toBeVisible();
    const cdp = await context.newCDPSession(options);
    const versions = new Map<
      string,
      { versionId: string; scriptURL: string; runningStatus: string }
    >();
    cdp.on("ServiceWorker.workerVersionUpdated", ({ versions: updates }) => {
      for (const version of updates) versions.set(version.versionId, version);
    });
    await cdp.send("ServiceWorker.enable");
    await options.getByTestId("accounts-add").click();
    await expect
      .poll(async () => (await audit(options)).waiting.length)
      .toBeGreaterThanOrEqual(2);
    const prior = (await audit(options)).waiting.at(-1)!;
    expect(prior.interval).toBe(6);
    await expect
      .poll(() =>
        [...versions.values()].some(
          (version) => version.scriptURL === worker.url(),
        ),
      )
      .toBe(true);
    const version = [...versions.values()].find(
      (value) => value.scriptURL === worker.url(),
    )!;
    await cdp.send("ServiceWorker.stopWorker", {
      versionId: version.versionId,
    });
    await expect
      .poll(() => versions.get(version.versionId)?.runningStatus)
      .toBe("stopped");
    await expect(options.getByTestId("account-card-restored")).toBeVisible({
      timeout: 12_000,
    });
    expect(polls).toBe(2);
    const observed = await assertAudit(options);
    for (const waiting of observed.waiting) {
      expect(waiting.flowId).toBe(prior.flowId);
      expect(waiting.expiresAt).toBe(prior.expiresAt);
    }
    const current = context
      .serviceWorkers()
      .find((candidate) => candidate.url() === worker.url());
    expect(current).toBeDefined();
    expect(
      await current!.evaluate(async () => {
        const api = (globalThis as unknown as { chrome: NativeChrome }).chrome;
        const result = await api.storage.session.get(
          "background:device-flows:v1",
        );
        return JSON.stringify(result).includes("SYNTHETIC_");
      }),
    ).toBe(false);
    const connectedAccountCount = await options.evaluate(async () => {
      const result = (await (
        globalThis as unknown as { chrome: NativeChrome }
      ).chrome.runtime.sendMessage({ type: "getUISnapshot" })) as {
        data: { accounts: unknown[] };
      };
      return result.data.accounts.length;
    });
    expect(connectedAccountCount).toBe(1);
    await testInfo.attach("worker-restoration", {
      body: JSON.stringify({
        stopMethod: "ServiceWorker.stopWorker",
        stoppedObserved: true,
        polls,
        flowId: prior.flowId,
        interval: prior.interval,
        originalDeadline: prior.expiresAt,
        successfulTokenResponses: polls - 1,
        connectedAccountCount,
      }),
      contentType: "application/json",
    });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

for (const schemaVersion of [3, 4])
  test(`upgrades a synthetic v${schemaVersion} profile without losing credentials/preferences and reestablishes content storage denial`, async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBe("chromium");
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "ghpsr-profile-upgrade-"),
    );
    const packagePath = path.join(directory, "extension");
    const profile = path.join(directory, "profile");
    let context: BrowserContext | undefined;
    try {
      await cp(extension, packagePath, { recursive: true });
      const manifestPath = path.join(packagePath, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, version: "1.16.0" }),
      );
      // A deliberately tiny old-extension fixture owns seed creation; no UI is
      // given these synthetic credentials. The new production package replaces it.
      const legacyAccount = {
        id: "legacy",
        login: "legacy-user",
        avatarUrl: null,
        createdAt: 1,
        token: ACCESS,
        refreshToken: REFRESH,
        expiresAt: 9999999999999,
        refreshTokenExpiresAt: 9999999999999,
        invalidated: false,
        invalidatedReason: null,
        installations: [],
        installationsRefreshedAt: 1,
      };
      const seed = {
        ...(schemaVersion === 3
          ? { settings: { version: 3, accounts: [legacyAccount] } }
          : {
              settings: { version: 4, accountIds: ["legacy"] },
              "account:profile:legacy": {
                id: "legacy",
                login: "legacy-user",
                avatarUrl: null,
                createdAt: 1,
              },
              "account:auth:legacy": {
                token: ACCESS,
                refreshToken: REFRESH,
                expiresAt: 9999999999999,
                refreshTokenExpiresAt: 9999999999999,
                invalidated: false,
                invalidatedReason: null,
                credentialGeneration: "preserved-v4-generation",
              },
              "account:installations:legacy": {
                installations: [],
                installationsRefreshedAt: 1,
              },
            }),
        preferences: {
          version: 1,
          language: "ko",
          showStateBadge: false,
          showReviewerName: true,
          openPullsOnly: false,
        },
      };
      await writeFile(
        path.join(packagePath, "background.js"),
        `chrome.runtime.onInstalled.addListener(async () => {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
      await chrome.storage.local.set(${JSON.stringify(seed)});
    });`,
      );
      context = await launch(profile, packagePath, true);
      const oldWorker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent("serviceworker"));
      await expect
        .poll(() =>
          oldWorker.evaluate(async () => {
            const result = await (
              globalThis as unknown as { chrome: NativeChrome }
            ).chrome.storage.local.get("settings");
            return (result.settings as { version?: number } | undefined)
              ?.version;
          }),
        )
        .toBe(schemaVersion);
      const oldId = new URL(oldWorker.url()).host;
      await context.close();
      context = undefined;
      await cp(extension, packagePath, { recursive: true });
      context = await launch(profile, packagePath, true);
      // Explicitly register the replacement unpacked package with Chrome while
      // retaining the existing profile and extension ID (no uninstall/clear).
      const reload = await context.browser()!.newBrowserCDPSession();
      const loaded = await reload.send("Extensions.loadUnpacked", {
        path: packagePath,
      });
      expect(loaded.id).toBe(oldId);
      await reload.detach();
      let oauthRequests = 0;
      await context.route("https://**/*", (route) => {
        if (route.request().url().includes("/login/")) oauthRequests++;
        return route.abort();
      });
      await installOptionsAudit(context);
      await routeFixture(context);
      const options = await context.newPage();
      await options.goto(`chrome-extension://${oldId}/options.html`);
      await expect(options.getByTestId("language-select")).toBeVisible({
        timeout: 10_000,
      });
      const worker = context.serviceWorkers()[0]!;
      expect(new URL(worker.url()).host).toBe(oldId);
      await options.reload();
      await expect(
        options.getByTestId("account-card-legacy-user"),
      ).toBeVisible();
      await expect(options.getByTestId("language-select")).toHaveValue("ko");
      await expect(
        options.getByTestId("prefs-show-reviewer-name"),
      ).toBeChecked();
      await expect(
        options.getByTestId("prefs-show-state-badge"),
      ).not.toBeChecked();
      await expect(
        options.getByTestId("prefs-open-pulls-only"),
      ).not.toBeChecked();
      const retained = await worker.evaluate(
        async ({ access, refresh }) => {
          const data = await (
            globalThis as unknown as { chrome: NativeChrome }
          ).chrome.storage.local.get(["settings", "account:auth:legacy"]);
          const auth = data["account:auth:legacy"] as
            | {
                token?: string;
                refreshToken?: string;
                credentialGeneration?: string;
              }
            | undefined;
          const settings = data.settings as
            | { version?: number; accountIds?: string[] }
            | undefined;
          return {
            version: settings?.version,
            ids: settings?.accountIds,
            accessPreserved: auth?.token === access,
            refreshPreserved: auth?.refreshToken === refresh,
            generationPreserved:
              auth?.credentialGeneration === "preserved-v4-generation",
          };
        },
        { access: ACCESS, refresh: REFRESH },
      );
      expect(retained).toEqual({
        version: 4,
        ids: ["legacy"],
        accessPreserved: true,
        refreshPreserved: true,
        generationPreserved: schemaVersion === 4,
      });
      const page = await context.newPage();
      expect(
        await evaluateContent(
          await contentContext(
            context,
            page,
            "https://github.com/octo/repo/pulls",
          ),
          storageDenial,
        ),
      ).toEqual(denied);
      expect(oauthRequests).toBe(0);
      await assertAudit(options);
      await testInfo.attach("profile-upgrade", {
        body: JSON.stringify({
          previousVersion: "1.16.0",
          previousStorageSchema: schemaVersion,
          currentVersion: manifest.version,
          ...retained,
          contentStorageDenied: true,
          forcedSignInRequests: oauthRequests,
        }),
        contentType: "application/json",
      });
    } finally {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
