// Standalone Node probe: never import into the Playwright Test runner, whose
// default locale injection would invalidate native-language observations.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  chromium,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { resolveLocale, toLanguageTag } from "../../src/i18n/locale.ts";

const [oldArg, newArg, expectedNewHash, outputArg] = process.argv.slice(2);
assert(
  oldArg && newArg && expectedNewHash && outputArg,
  "Usage: release-upgrade-probe.ts <published-v1.15.0.zip> <checked-v1.16.0.zip> <expected-new-sha256> <output.json>",
);
const oldZip = path.resolve(oldArg);
const newZip = path.resolve(newArg);
const output = path.resolve(outputArg);
const digest = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const oldHash =
  "686992ae1b0a332d28a17a0c8e99e848abc5e793cf2e39622bfdf22c946d1c70";
assert.equal(
  digest(readFileSync(oldZip)),
  oldHash,
  "Published baseline digest",
);
assert.equal(statSync(oldZip).size, 160730, "Published baseline size");
assert.match(expectedNewHash, /^[a-f0-9]{64}$/);
assert.equal(
  digest(readFileSync(newZip)),
  expectedNewHash,
  "Checked new ZIP digest",
);
const zipEntries = (zip: string) =>
  execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n");
const zipManifest = (zip: string) =>
  JSON.parse(
    execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" }),
  );
const oldManifest = zipManifest(oldZip);
const newManifest = zipManifest(newZip);
assert.equal(oldManifest.version, "1.15.0");
assert.equal(newManifest.version, "1.16.0");
assert.equal(newManifest.default_locale, "en");
assert.deepEqual(newManifest.permissions, oldManifest.permissions);
assert.deepEqual(newManifest.host_permissions, oldManifest.host_permissions);
const builtOutput = path.resolve(".output/chrome-mv3");
const packagedFiles = zipEntries(newZip).filter(
  (entry) => !entry.endsWith("/"),
);
const builtFiles = readdirSync(builtOutput, {
  recursive: true,
  withFileTypes: true,
})
  .filter((entry) => entry.isFile())
  .map((entry) =>
    path.relative(builtOutput, path.join(entry.parentPath, entry.name)),
  );
assert.deepEqual(
  builtFiles.sort(),
  [...packagedFiles].sort(),
  "Production test directory has exact ZIP inventory",
);
for (const entry of packagedFiles) {
  assert.equal(
    digest(readFileSync(path.join(builtOutput, entry))),
    digest(execFileSync("unzip", ["-p", newZip, entry])),
    `Production test directory matches ZIP: ${entry}`,
  );
}
assert.deepEqual(
  newManifest.content_scripts.map((s: { matches: string[] }) => s.matches),
  oldManifest.content_scripts.map((s: { matches: string[] }) => s.matches),
);

// Only this newly-created disposable directory is ever replaced/removed.
const temporary = await mkdtemp(path.join(os.tmpdir(), "ghpsr-real-upgrade-"));
const extension = path.join(temporary, "extension");
const profile = path.join(temporary, "profile");
const launchArgs = [
  `--disable-extensions-except=${extension}`,
  `--load-extension=${extension}`,
  "--lang=ko",
  "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>",
];
// The closed loopback proxy blocks external traffic even before routing is ready,
// including browser/service-worker startup. No real auth or private API is used.
let interceptedRequests = 0;
async function launch() {
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: launchArgs,
  });
  await context.route("**/*", async (route) => {
    if (/^https?:/.test(route.request().url())) {
      interceptedRequests++;
      await route.abort();
    } else await route.continue();
  });
  return context;
}
async function install(zip: string) {
  const entries = zipEntries(zip);
  assert(
    entries.every(
      (entry) => !entry.startsWith("/") && !entry.split("/").includes(".."),
    ),
    "Safe ZIP entries",
  );
  await mkdir(extension, { recursive: true });
  execFileSync("unzip", ["-q", zip, "-d", extension]);
  // Every extracted file must be identical to its ZIP member; no patched manifest.
  for (const entry of entries.filter((entry) => !entry.endsWith("/"))) {
    assert.equal(
      digest(readFileSync(path.join(extension, entry))),
      digest(execFileSync("unzip", ["-p", zip, entry])),
      `Exact extracted member: ${entry}`,
    );
  }
}
async function options(context: BrowserContext, firstInstall = false) {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  if (!firstInstall)
    await worker.evaluate(async () => {
      await (
        globalThis as unknown as {
          chrome: { runtime: { openOptionsPage(): Promise<void> } };
        }
      ).chrome.runtime.openOptionsPage();
    });
  const url = `chrome-extension://${id}/options.html`;
  await expect
    .poll(() =>
      context
        .pages()
        .find((page) => page.url() === url)
        ?.url(),
    )
    .toBe(url);
  const page = context.pages().find((page) => page.url() === url)!;
  await expect(page.getByTestId("prefs-show-state-badge")).toBeVisible();
  return { page, id };
}
type Storage = Record<string, unknown>;
type ChromeAPI = {
  storage: {
    local: {
      get(key: null): Promise<Storage>;
      set(value: Storage): Promise<void>;
    };
  };
  runtime: {
    getManifest(): {
      version: string;
      description: string;
      current_locale?: string;
    };
  };
  i18n: { getUILanguage(): string; getMessage(key: string): string };
};
const accounts: Storage = {
  settings: { version: 4, accountIds: ["upgrade-all", "upgrade-selected"] },
};
for (const [index, id] of ["upgrade-all", "upgrade-selected"].entries()) {
  accounts[`account:profile:${id}`] = {
    id,
    login: id,
    avatarUrl: null,
    createdAt: index + 1,
  };
  accounts[`account:auth:${id}`] = {
    token: `synthetic-${randomBytes(24).toString("hex")}`,
    refreshToken: `synthetic-${randomBytes(24).toString("hex")}`,
    expiresAt: Date.now() + 86400000,
    refreshTokenExpiresAt: Date.now() + 172800000,
    invalidated: false,
    invalidatedReason: null,
  };
  accounts[`account:installations:${id}`] = {
    installations: [
      {
        id: index + 1,
        account: { login: id, type: "Organization", avatarUrl: null },
        repositorySelection: index === 0 ? "all" : "selected",
        repoSnapshot:
          index === 0
            ? null
            : {
                fullNames: ["upgrade-selected/synthetic-repository"],
                completeness: "complete",
              },
      },
    ],
    installationsRefreshedAt: 1,
  };
}
const oldPreferences = {
  version: 1,
  showStateBadge: false,
  showReviewerName: true,
  openPullsOnly: false,
};
// Compare secrets within the extension page; return only booleans/digests.
async function snapshot(page: Page, preferences: Storage) {
  return page.evaluate(
    async ({ accounts, preferences }) => {
      const api = (globalThis as unknown as { chrome: ChromeAPI }).chrome;
      const raw = await api.storage.local.get(null);
      const canonical = (value: unknown): string => {
        if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (value && typeof value === "object")
          return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
            .join(",")}}`;
        return JSON.stringify(value);
      };
      const hashes: Record<string, string> = {};
      const retained: Record<string, boolean> = {};
      for (const [key, expected] of Object.entries({
        ...accounts,
        preferences,
      })) {
        retained[key] = canonical(raw[key]) === canonical(expected);
        const bytes = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(canonical(raw[key])),
        );
        hashes[key] = Array.from(new Uint8Array(bytes), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
      }
      return {
        manifest: api.runtime.getManifest(),
        uiLanguage: api.i18n.getUILanguage(),
        processLocaleMessage: api.i18n.getMessage("@@ui_locale"),
        navigatorLanguage: navigator.language,
        retained,
        hashes,
        rawStorageKeys: Object.keys(raw).sort(),
        rawLanguagePresent: Object.hasOwn(
          (raw.preferences ?? {}) as object,
          "language",
        ),
      };
    },
    { accounts, preferences },
  );
}
async function verifyDisplay(page: Page) {
  await expect(page.getByTestId("prefs-show-state-badge")).not.toBeChecked();
  await expect(page.getByTestId("prefs-show-reviewer-name")).toBeChecked();
  await expect(page.getByTestId("prefs-open-pulls-only")).not.toBeChecked();
  for (const id of ["upgrade-all", "upgrade-selected"])
    await expect(
      page.locator(".account-row").filter({ hasText: id }),
    ).toHaveCount(1);
}
let context: BrowserContext | undefined;
try {
  await install(oldZip);
  context = await launch();
  const old = await options(context, true);
  assert.equal((await snapshot(old.page, {})).manifest.version, "1.15.0");
  await expect(old.page.getByTestId("language-select")).toHaveCount(0);
  await old.page.evaluate(async (value) => {
    await (
      globalThis as unknown as { chrome: ChromeAPI }
    ).chrome.storage.local.set(value);
  }, accounts);
  await old.page.reload();
  // Use actual old UI writes to exercise all three non-default display values.
  for (const [id, field, value] of [
    ["prefs-show-state-badge", "showStateBadge", false],
    ["prefs-show-reviewer-name", "showReviewerName", true],
    ["prefs-open-pulls-only", "openPullsOnly", false],
  ] as const) {
    await expect(old.page.getByTestId(id)).toBeChecked({ checked: !value });
    await old.page.getByTestId(id).click();
    // Old controlled inputs commit checked state after the async storage write.
    // setChecked's immediate post-click assertion can run before that commit.
    await expect
      .poll(() =>
        old.page.evaluate(async (field) => {
          const raw = await (
            globalThis as unknown as { chrome: ChromeAPI }
          ).chrome.storage.local.get(null);
          return (raw.preferences as Record<string, unknown> | undefined)?.[
            field
          ];
        }, field),
      )
      .toBe(value);
    await expect(old.page.getByTestId(id)).toBeChecked({ checked: value });
    await expect(old.page.getByTestId(id)).toBeEnabled();
  }
  await verifyDisplay(old.page);
  const oldObserved = await snapshot(old.page, oldPreferences);
  assert(
    Object.values(oldObserved.retained).every(Boolean),
    "Old runtime raw records match seeded accounts and UI-written preferences",
  );
  assert.equal(oldObserved.rawLanguagePresent, false);
  await context.close();
  context = undefined;

  // Same profile and exact unpacked path keep identity stable. Original ZIP stays untouched.
  await rm(extension, { recursive: true });
  await install(newZip);
  execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/verify-packaged-locales.mjs",
      extension,
    ],
    { stdio: "inherit" },
  );
  context = await launch();
  const updated = await options(context);
  assert.equal(updated.id, old.id, "Same installed extension identity");
  await expect(updated.page.getByTestId("language-select")).toHaveValue("auto");
  await verifyDisplay(updated.page);
  const newObserved = await snapshot(updated.page, oldPreferences);
  assert.equal(newObserved.manifest.version, "1.16.0");
  assert(
    Object.values(newObserved.retained).every(Boolean),
    "Upgrade retains exact raw account/auth/installations/preferences records",
  );
  assert.equal(
    newObserved.rawLanguagePresent,
    false,
    "Auto is a parsed default, not a destructive storage rewrite",
  );
  assert.deepEqual(newObserved.hashes, oldObserved.hashes);
  const autoLocale = resolveLocale(newObserved.uiLanguage);
  await expect(updated.page.locator("html")).toHaveAttribute(
    "lang",
    toLanguageTag(autoLocale),
  );
  const catalog = JSON.parse(
    readFileSync(
      path.join(extension, "_locales", autoLocale, "messages.json"),
      "utf8",
    ),
  );
  await expect(updated.page.locator("#accounts-title")).toHaveText(
    catalog.options_accounts_title.message,
  );
  await updated.page.getByTestId("language-select").selectOption("zh_TW");
  await expect(updated.page.locator("html")).toHaveAttribute("lang", "zh-TW");
  const manualObserved = await snapshot(updated.page, {
    ...oldPreferences,
    language: "zh_TW",
  });
  assert(
    Object.values(manualObserved.retained).every(Boolean),
    "Manual language preserves records",
  );
  assert.deepEqual(
    manualObserved.manifest,
    newObserved.manifest,
    "Manual UI selection leaves native metadata unchanged",
  );
  await context.close();
  context = undefined;

  context = await launch();
  const restarted = await options(context);
  assert.equal(restarted.id, old.id);
  await expect(restarted.page.getByTestId("language-select")).toHaveValue(
    "zh_TW",
  );
  await expect(restarted.page.locator("html")).toHaveAttribute("lang", "zh-TW");
  await verifyDisplay(restarted.page);
  const restartObserved = await snapshot(restarted.page, {
    ...oldPreferences,
    language: "zh_TW",
  });
  assert(
    Object.values(restartObserved.retained).every(Boolean),
    "Process restart retains every record including manual language",
  );
  assert.deepEqual(restartObserved.hashes, manualObserved.hashes);
  assert.deepEqual(restartObserved.manifest, newObserved.manifest);
  assert.equal(
    digest(readFileSync(oldZip)),
    oldHash,
    "Original baseline unchanged",
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        result: "PASS",
        observedAt: new Date().toISOString(),
        sourceSha: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        sourceChanges: execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
        }).trim(),
        oldArtifact: {
          path: oldZip,
          assetId: 542519485,
          sha256: oldHash,
          size: statSync(oldZip).size,
        },
        newArtifact: {
          path: newZip,
          sha256: expectedNewHash,
          size: statSync(newZip).size,
          entries: zipEntries(newZip),
        },
        sizeDeltaBytes: statSync(newZip).size - statSync(oldZip).size,
        execution: "standalone-node",
        platform: process.platform,
        chromiumVersion: context.browser()?.version(),
        headless: true,
        playwrightLocale: null,
        launchArgs,
        extensionId: old.id,
        sameProfile: true,
        sameUnpackedPath: true,
        exactExtractedMembers: true,
        productionTestDirectoryMatchesZip: true,
        externalTraffic:
          "Blocked by closed loopback proxy; intercepted HTTP(S) aborted",
        interceptedRequests,
        oldObserved,
        newObserved,
        autoLocale,
        manualObserved,
        restartObserved,
        limitations: [
          "Controlled unpacked update, not signed Chrome Web Store auto-update",
          "Synthetic accounts only; no live auth or private API",
          "Only observed native locale configuration, not five OS locales",
          "Temporary profile removed; reproducible script and sanitized evidence retained",
        ],
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `PASS: real 1.15.0 -> 1.16.0 profile upgrade and restart; sanitized evidence ${output}\n`,
  );
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
}
