// Executed with Node, never imported into the Playwright test runner. The runner
// injects locale=en-US into persistent contexts even when locale is omitted.
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { resolveLocale, toLanguageTag } from "../../src/i18n/locale.ts";

const extension = path.resolve(".output/chrome-mv3");
const output = process.argv[2];
if (!output) throw new Error("Usage: native-locale-probe.ts <output.json>");
await mkdir(path.dirname(output), { recursive: true });

const catalog = (locale: string) =>
  JSON.parse(
    readFileSync(
      path.join(extension, "_locales", locale, "messages.json"),
      "utf8",
    ),
  ) as Record<
    string,
    { message: string; placeholders?: Record<string, { content: string }> }
  >;
// Read the native API, never infer it from Playwright's navigator locale.
async function chromeLanguage(page: Page) {
  return page.evaluate(async () => {
    const api = (
      globalThis as unknown as {
        chrome: {
          i18n: {
            getUILanguage(): string;
            getMessage(key: string, values?: string[]): string;
          };
          runtime: { getManifest(): {
            name: string;
            description: string;
            current_locale: string;
            action: { default_title: string };
          } };
          action: { getTitle(details: object): Promise<string> };
        };
      }
    ).chrome;
    return {
      uiLanguage: api.i18n.getUILanguage(),
      catalogLanguage: api.i18n.getMessage("@@ui_locale"),
      navigatorLanguage: navigator.language,
      userAgent: navigator.userAgent,
      manifest: api.runtime.getManifest(),
      toolbar: await api.action.getTitle({}),
      description: api.i18n.getMessage("extension_description"),
    };
  });
}
async function uiSnapshot(page: Page) {
  return {
    preference: await page.getByTestId("language-select").inputValue(),
    lang: await page.locator("html").getAttribute("lang"),
    accountsHeading: await page.locator("#accounts-title").textContent(),
  };
}

async function installedOptions(context: BrowserContext) {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const url = `chrome-extension://${new URL(worker.url()).host}/options.html`;
  // Retain #159's deterministic ownership of the first navigation.
  await expect
    .poll(() =>
      context
        .pages()
        .find((p) => p.url() === url)
        ?.url(),
    )
    .toBe(url);
  const page = context.pages().find((p) => p.url() === url)!;
  await expect(page.getByTestId("language-select")).toBeVisible();
  return { page, url };
}

const profile = await mkdtemp(path.join(os.tmpdir(), "ghpsr-native-locale-"));
const launch = () =>
  chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--lang=ko",
    ],
  });
let context = await launch();
try {
  await context.route("https://**/*", (route) => route.abort());
  const { page, url } = await installedOptions(context);
  const native = await chromeLanguage(page);
  const resolved = resolveLocale(native.uiLanguage);
  // Chromium records the manifest localization separately from the renderer's
  // @@ui_locale. Linux CI can report English here with a Korean manifest.
  const messageLocale = resolveLocale(native.catalogLanguage);
  expect(native.manifest.current_locale).toBeTruthy();
  const metadataLocale = resolveLocale(native.manifest.current_locale);
  const messages = catalog(messageLocale);
  const metadata = catalog(metadataLocale);
  const observation = {
    execution: "standalone-node-subprocess",
    platform: process.platform,
    languageEnvironment: Object.fromEntries(
      ["LANG", "LANGUAGE", "LC_ALL", "LC_MESSAGES"].map((key) => [
        key, process.env[key] ?? null,
      ]),
    ),
    requestedFlag: "ko",
    playwrightLocale: null,
    beforeOverride: native,
    autoLocale: resolved,
    messageLocale,
    metadataLocale,
  };
  // Preserve raw observations even if a later contract fails. CI has no artifact
  // upload step, so also emit this non-sensitive fixture data to its test log.
  await writeFile(output, JSON.stringify(observation, null, 2));
  process.stdout.write(`Native locale observation: ${JSON.stringify(observation)}\n`);
  await expect(page.locator("html")).toHaveAttribute(
    "lang",
    toLanguageTag(resolved),
  );
  await expect(page.getByTestId("language-select")).toHaveValue("auto");
  await expect(page.locator("#accounts-title")).toHaveText(
    catalog(resolved).options_accounts_title.message,
  );
  const autoUI = await uiSnapshot(page);
  expect(native.manifest.name).toBe("GitHub Pulls Show Reviewers");
  expect(native.manifest.description).toBe(
    metadata.extension_description.message,
  );
  expect(native.description).toBe(messages.extension_description.message);
  expect(native.manifest.action.default_title).toBe(
    metadata.extension_action_title.message,
  );
  expect(native.toolbar).toBe(metadata.extension_action_title.message);
  // Chrome must accept and interpolate every emitted message in its selected catalog.
  const nativeMessages = await page.evaluate((keys) => {
    const api = (
      globalThis as unknown as {
        chrome: {
          i18n: { getMessage(key: string, values: string[]): string };
        };
      }
    ).chrome;
    return Object.fromEntries(
      keys.map((key) => [
        key,
        api.i18n.getMessage(key, ["ARG1", "ARG2", "ARG3"]),
      ]),
    );
  }, Object.keys(messages));
  for (const [key, entry] of Object.entries(messages)) {
    expect(nativeMessages[key], key).toBe(
      entry.message.replace(/\$([A-Z_]+)\$/g, (_, name: string) => {
        const position =
          entry.placeholders![name.toLowerCase()].content.slice(1);
        return `ARG${position}`;
      }),
    );
  }
  await page.getByTestId("language-select").selectOption("zh_TW");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
  await expect(page.locator("#accounts-title")).toHaveText(
    catalog("zh_TW").options_accounts_title.message,
  );
  const manualUI = await uiSnapshot(page);
  const afterOverride = await chromeLanguage(page);
  expect(afterOverride).toEqual(native);
  await page.reload();
  await expect(page.getByTestId("language-select")).toHaveValue("zh_TW");
  const reloadedUI = await uiSnapshot(page);
  expect(reloadedUI).toEqual(manualUI);
  const afterReload = await chromeLanguage(page);
  expect(afterReload).toEqual(native);
  await context.close();
  context = await launch();
  await context.route("https://**/*", (route) => route.abort());
  // onInstalled does not run again on process restart; navigate explicitly.
  const restored = await context.newPage();
  await restored.goto(url);
  await expect(restored.getByTestId("language-select")).toHaveValue("zh_TW");
  await expect(restored.locator("html")).toHaveAttribute("lang", "zh-TW");
  const restartedUI = await uiSnapshot(restored);
  expect(restartedUI).toEqual(manualUI);
  const afterProcessRestart = await chromeLanguage(restored);
  expect(afterProcessRestart).toEqual(native);
  await restored.getByTestId("language-select").selectOption("auto");
  await expect(restored.locator("html")).toHaveAttribute(
    "lang",
    toLanguageTag(resolved),
  );
  await expect(restored.locator("#accounts-title")).toHaveText(
    catalog(resolved).options_accounts_title.message,
  );
  const returnedAutoUI = await uiSnapshot(restored);
  expect(returnedAutoUI).toEqual(autoUI);
  await writeFile(
    output,
    JSON.stringify(
      {
        ...observation,
        headless: true,
        channel: "chromium",
        launchArgs: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
          "--lang=ko",
        ],
        requestedFlag: "ko",
        playwrightLocale: null,
        autoUI,
        manualUI,
        reloadedUI,
        restartedUI,
        returnedAutoUI,
        beforeOverride: native,
        afterOverride,
        afterReload,
        afterProcessRestart,
        autoLocale: resolved,
        manualLocale: "zh_TW",
        returnedAutoLocale: resolved,
        metadataLocale,
        checkedMessages: Object.keys(messages).length,
        reload: true,
        processRestart: true,
        overrideIndependent: true,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
