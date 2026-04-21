# GitHub App + Device Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Classic PAT auth with a GitHub App + OAuth Device Flow, add multi-account storage keyed on installations, and drop all PAT code, copy, and tests. The public no-token path is preserved.

**Architecture:** The content script resolves an `Account` for each PR row via installation data; the options page runs the device flow and installations fetch; a new page-level banner aggregates uncovered orgs. Device code polling lives on the options page because MV3 service workers unload and break `setInterval`. The extension remains purely client-side — no backend, no client secret.

**Tech Stack:** WXT Chrome extension, TypeScript, React 19 options UI, Zod validation, Vitest (jsdom) for unit tests, Playwright for e2e, pnpm.

---

## Scope Check

The spec is one coordinated migration: auth, storage, content-script rendering, options UI, docs, and release artifacts all pivot together to GitHub App + device flow. It is not broken into sub-projects because partial shipping (for example, new storage with old auth) produces a non-working extension. One plan is correct.

## File Structure

**New code:**

- `src/config/github-app.ts` — reads `WXT_GITHUB_APP_*` env vars at build time, throws on missing required values in production, provides safe dev defaults.
- `src/storage/accounts.ts` — `Account` / `Installation` Zod schemas, `getSettings`, `listAccounts`, `addAccount`, `removeAccount`, `replaceInstallations`, `markAccountInvalidated`, `resolveAccountForRepo`.
- `src/github/auth.ts` — `initiateDeviceFlow`, `pollForAccessToken`, `fetchAuthenticatedUser`, `fetchUserInstallations`, `fetchInstallationRepositories`.
- `src/features/access-banner/aggregator.ts` — per-page-session state for uncovered orgs, rate-limit signal, and dismissal memory (`sessionStorage`-backed).
- `src/features/access-banner/dom.ts` — banner DOM insertion, dismiss wiring, teardown.
- `src/features/access-banner/index.ts` — content-script entry that subscribes the banner to aggregator updates.
- `entrypoints/options/device-flow-controller.ts` — React hook orchestrating the state machine, polling, cancellation, expiry.
- `entrypoints/options/components/AddAccountPanel.tsx` — inline device flow UI.
- `entrypoints/options/components/AccountsList.tsx` — account cards with Refresh / Remove / Sign in again.
- `entrypoints/options/components/DiagnosticsPanel.tsx` — account-oriented diagnostics.

**Modified code:**

- `src/github/api.ts` — keep `fetchPullReviewerSummary(…)` signature; replace PAT/SSO copy in `describeGitHubApiError`; rewrite `validateGitHubRepositoryAccess` and `validateGitHubToken` to take an `Account | null` and describe results in App-aware language. Reviewer-summary result type gains a `status` used by the banner aggregator (see Task 6 / Task 8).
- `src/features/reviewers/index.ts` — swap `resolveTokenEntryForRepository` for `resolveAccountForRepo`, drop `renderError`, emit banner aggregator signals on API failure.
- `src/features/reviewers/view-model.ts` — drop error branches.
- `src/features/reviewers/dom.ts` — delete `renderError` export and the `.ghpsr-status--error` styles.
- `entrypoints/content.ts` — boot the access-banner feature in addition to the reviewer feature.
- `entrypoints/options/options-page.tsx` — delete the Classic PAT token list / form / repository-check UI; compose `AccountsList`, `AddAccountPanel`, `DiagnosticsPanel`, and an "About this extension" section.
- `entrypoints/options/main.tsx` — unchanged structurally; adjust imports only.
- `wxt.config.ts` — bridge `WXT_GITHUB_APP_CLIENT_ID`, `WXT_GITHUB_APP_SLUG`, `WXT_GITHUB_APP_NAME` into the bundle via `vite.define`.

**Deleted code:**

- `src/storage/settings.ts`
- `src/storage/token-scopes.ts`
- `tests/settings.test.ts`
- `tests/token-scopes.test.ts`

**Tests:**

- `tests/accounts.test.ts` (new) — storage CRUD, schema rejection, `resolveAccountForRepo` table-driven matching, invalidation.
- `tests/auth.test.ts` (new) — device flow poll states, slow_down interval bump, expired-token handling, installations pagination, partial-failure behavior.
- `tests/access-banner.test.ts` (new) — aggregator dedup, dismissal memory, banner message formatting.
- `tests/device-flow-controller.test.ts` (new) — hook lifecycle via `@testing-library/react` (`pending → connected`, cancel, expiry, retry).
- `tests/api.test.ts` — update existing tests to drop PAT/SSO wording and the `token-scopes` import, add App-aware error copy assertions.
- `tests/fixtures/repository-validation-matrix.json` — rewrite every PAT / SSO message assertion in App-aware language.
- `tests/options-page.test.ts` — rewrite against the new component composition (rendering the add-account panel, the accounts list empty state, the diagnostics entry point).
- `tests/e2e/extension.spec.ts` — adjust fixture token plumbing to source the token from an `Account` object.
- New fixtures in `tests/fixtures/github-api/`: `user.json`, `user-installations.json`, `installation-repositories.json`, `device-code-init.json`, `access-token-pending.json`, `access-token-slow-down.json`, `access-token-expired.json`, `access-token-denied.json`, `access-token-success.json`.

**Docs and ADR:**

- `docs/adr/0003-github-app-device-flow.md` (create).
- `docs/adr/0002-classic-pat-interim-auth.md` — status line only: `Accepted` → `Superseded by ADR 0003 (2026-04-21)`. Body unchanged.
- `README.md` — rewrite the "Authentication Model" section.
- `AGENTS.md` — the private-repository bullet under "Product Rules" is rewritten for App installation (not PAT).
- `docs/implementation-notes.md` — drop PAT / scope sections; add Device Flow + Installation-based matching sections.
- `docs/privacy-policy.md` — replace the PAT sentence with user-to-server token description; list the new stored fields.
- `docs/chrome-web-store.md`, `docs/chrome-web-store-submission.md` — rewrite around "Sign in with GitHub (via our GitHub App)".
- `docs/manual-chrome-testing.md` — delete the four PAT scenarios, add the five device flow scenarios.

**Release:**

- `.env.example` (create).
- `package.json` — `version` `1.1.0` → `1.2.0`.
- `docs/releases/v1.2.0.md` (create).

### Prerequisite (manual, outside the plan)

Before Task 1, register the GitHub App on github.com following §8.5 of the spec. Capture `Client ID` and `App slug` and store them as `GH_APP_CLIENT_ID` and `GH_APP_SLUG` in repository secrets; developers also put them in a local `.env.local` (gitignored). The plan assumes these values exist and does not block on them — tasks use `TESTING_CLIENT_ID` / `test-app` as dev defaults so tests run without secrets.

---

## Task 1: Configuration module and build-time env bridge

Add the module that owns runtime access to the GitHub App identifiers, the `.env.example` template, and the `wxt.config.ts` `vite.define` bridges. Later tasks import from `src/config/github-app.ts`; without this scaffolding everything downstream breaks.

**Files:**
- Create: `src/config/github-app.ts`
- Create: `.env.example`
- Modify: `wxt.config.ts`
- Create: `tests/github-app-config.test.ts`

- [ ] **Step 1: Write the failing test for missing required values in production**

Create `tests/github-app-config.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("github-app config", () => {
  it("exports dev defaults when running outside production", async () => {
    vi.stubGlobal("__GITHUB_APP_CLIENT_ID__", "dev-client-id");
    vi.stubGlobal("__GITHUB_APP_SLUG__", "dev-slug");
    vi.stubGlobal("__GITHUB_APP_NAME__", "Dev App");
    vi.stubGlobal("__PROD__", false);

    const { getGitHubAppConfig } = await import("../src/config/github-app");
    expect(getGitHubAppConfig()).toEqual({
      clientId: "dev-client-id",
      slug: "dev-slug",
      name: "Dev App",
    });
  });

  it("throws when a required value is missing in production", async () => {
    vi.stubGlobal("__GITHUB_APP_CLIENT_ID__", "");
    vi.stubGlobal("__GITHUB_APP_SLUG__", "");
    vi.stubGlobal("__GITHUB_APP_NAME__", "");
    vi.stubGlobal("__PROD__", true);

    const mod = await import("../src/config/github-app");
    expect(() => mod.getGitHubAppConfig()).toThrow(
      /WXT_GITHUB_APP_CLIENT_ID/,
    );
  });

  it("falls back to sensible dev defaults when the globals are undefined", async () => {
    vi.stubGlobal("__GITHUB_APP_CLIENT_ID__", undefined);
    vi.stubGlobal("__GITHUB_APP_SLUG__", undefined);
    vi.stubGlobal("__GITHUB_APP_NAME__", undefined);
    vi.stubGlobal("__PROD__", false);

    const { getGitHubAppConfig } = await import("../src/config/github-app");
    expect(getGitHubAppConfig()).toEqual({
      clientId: "Iv1.devclientdev",
      slug: "github-pulls-show-reviewers-dev",
      name: "GitHub Pulls Show Reviewers (dev)",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/github-app-config.test.ts`
Expected: FAIL with "Cannot find module '../src/config/github-app'".

- [ ] **Step 3: Create `src/config/github-app.ts`**

```ts
declare const __GITHUB_APP_CLIENT_ID__: string | undefined;
declare const __GITHUB_APP_SLUG__: string | undefined;
declare const __GITHUB_APP_NAME__: string | undefined;
declare const __PROD__: boolean;

export type GitHubAppConfig = {
  clientId: string;
  slug: string;
  name: string;
};

const DEV_DEFAULTS: GitHubAppConfig = {
  clientId: "Iv1.devclientdev",
  slug: "github-pulls-show-reviewers-dev",
  name: "GitHub Pulls Show Reviewers (dev)",
};

export function getGitHubAppConfig(): GitHubAppConfig {
  const rawClientId =
    typeof __GITHUB_APP_CLIENT_ID__ === "string" ? __GITHUB_APP_CLIENT_ID__ : "";
  const rawSlug =
    typeof __GITHUB_APP_SLUG__ === "string" ? __GITHUB_APP_SLUG__ : "";
  const rawName =
    typeof __GITHUB_APP_NAME__ === "string" ? __GITHUB_APP_NAME__ : "";

  const isProd = typeof __PROD__ === "boolean" ? __PROD__ : false;

  if (isProd) {
    if (!rawClientId) {
      throw new Error("WXT_GITHUB_APP_CLIENT_ID must be set for production builds.");
    }
    if (!rawSlug) {
      throw new Error("WXT_GITHUB_APP_SLUG must be set for production builds.");
    }
  }

  return {
    clientId: rawClientId || DEV_DEFAULTS.clientId,
    slug: rawSlug || DEV_DEFAULTS.slug,
    name: rawName || DEV_DEFAULTS.name,
  };
}

export function buildInstallAppUrl(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- tests/github-app-config.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Create `.env.example`**

```text
# GitHub App identifiers used by src/config/github-app.ts via vite.define.
# Register a GitHub App (see docs/implementation-notes.md) and fill these in.
WXT_GITHUB_APP_CLIENT_ID=Iv1.exampleclientid
WXT_GITHUB_APP_SLUG=github-pulls-show-reviewers
WXT_GITHUB_APP_NAME=GitHub Pulls Show Reviewers
```

- [ ] **Step 6: Update `wxt.config.ts` to bridge env vars**

Replace the existing file with:

```ts
import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: ".",
  vite: () => ({
    define: {
      __GITHUB_APP_CLIENT_ID__: JSON.stringify(
        process.env.WXT_GITHUB_APP_CLIENT_ID ?? "",
      ),
      __GITHUB_APP_SLUG__: JSON.stringify(
        process.env.WXT_GITHUB_APP_SLUG ?? "",
      ),
      __GITHUB_APP_NAME__: JSON.stringify(
        process.env.WXT_GITHUB_APP_NAME ?? "",
      ),
      __PROD__: JSON.stringify(process.env.NODE_ENV === "production"),
    },
  }),
  manifest: {
    name: "GitHub Pulls Show Reviewers",
    description:
      "Show requested reviewers and review state directly in GitHub pull request lists.",
    icons: {
      16: "/icon/16.png",
      32: "/icon/32.png",
      48: "/icon/48.png",
      128: "/icon/128.png",
    },
    permissions: ["storage"],
    host_permissions: ["https://github.com/*", "https://api.github.com/*"],
  },
});
```

Keep `permissions` and `host_permissions` as-is: `https://github.com/*` already covers `/login/device` and `/login/oauth/access_token`.

- [ ] **Step 7: Verify typecheck still passes**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/config/github-app.ts .env.example wxt.config.ts tests/github-app-config.test.ts
git commit -m "feat(config): add GitHub App config module and env bridge"
```

---

## Task 2: Accounts storage — schemas and CRUD

Introduce `src/storage/accounts.ts` with the Zod schemas and basic persistence operations. `resolveAccountForRepo` is in the next task so failures are isolated. Keep `src/storage/settings.ts` and `src/storage/token-scopes.ts` in place for now; they are deleted in Task 17 once every caller has migrated.

**Files:**
- Create: `src/storage/accounts.ts`
- Create: `tests/accounts.test.ts`

- [ ] **Step 1: Write the failing tests for schemas and CRUD**

Create `tests/accounts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StorageShape = Record<string, unknown>;

function createBrowserMock() {
  let storage: StorageShape = {};
  const get = vi.fn(async (key?: string | string[] | Record<string, unknown>) => {
    if (typeof key === "string") {
      return key in storage ? { [key]: storage[key] } : {};
    }
    return { ...storage };
  });
  const set = vi.fn(async (items: StorageShape) => {
    storage = { ...storage, ...items };
  });
  return {
    browser: {
      storage: {
        local: { get, set },
      },
    },
    reset() {
      storage = {};
      get.mockClear();
      set.mockClear();
    },
  };
}

let browserMock: ReturnType<typeof createBrowserMock>;

beforeEach(() => {
  browserMock = createBrowserMock();
  vi.stubGlobal("browser", browserMock.browser);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("accounts storage", () => {
  it("returns an empty v2 settings shape when storage is empty", async () => {
    const { getSettings } = await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({
      version: 2,
      accounts: [],
    });
  });

  it("overwrites legacy tokenEntries payloads with an empty v2 shape", async () => {
    browserMock.browser.storage.local.get.mockResolvedValueOnce({
      settings: {
        tokenEntries: [
          { id: "x", scope: "hon454/*", token: "ghp_legacy", label: null },
        ],
      },
    });
    const { getSettings } = await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({
      version: 2,
      accounts: [],
    });
  });

  it("addAccount persists and listAccounts returns the account", async () => {
    const { addAccount, listAccounts } = await import("../src/storage/accounts");
    await addAccount({
      id: "acc-1",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_abc",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
    });
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].login).toBe("hon454");
  });

  it("removeAccount drops the matching id", async () => {
    const { addAccount, removeAccount, listAccounts } = await import(
      "../src/storage/accounts"
    );
    await addAccount({
      id: "acc-1",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_abc",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
    });
    await removeAccount("acc-1");
    await expect(listAccounts()).resolves.toEqual([]);
  });

  it("replaceInstallations swaps installations and bumps refreshedAt", async () => {
    const { addAccount, replaceInstallations, listAccounts } = await import(
      "../src/storage/accounts"
    );
    await addAccount({
      id: "acc-1",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_abc",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
    });
    await replaceInstallations("acc-1", [
      {
        id: 42,
        account: { login: "hon454", type: "User", avatarUrl: null },
        repositorySelection: "all",
        repoFullNames: null,
      },
    ]);
    const [account] = await listAccounts();
    expect(account.installations).toHaveLength(1);
    expect(account.installations[0].id).toBe(42);
    expect(account.installationsRefreshedAt).toBeGreaterThan(1);
  });

  it("markAccountInvalidated sets the invalidation fields", async () => {
    const { addAccount, markAccountInvalidated, listAccounts } = await import(
      "../src/storage/accounts"
    );
    await addAccount({
      id: "acc-1",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_abc",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
    });
    await markAccountInvalidated("acc-1", "revoked");
    const [account] = await listAccounts();
    expect(account.invalidated).toBe(true);
    expect(account.invalidatedReason).toBe("revoked");
  });

  it("rejects malformed account payloads at read time by resetting to empty", async () => {
    browserMock.browser.storage.local.get.mockResolvedValueOnce({
      settings: {
        version: 2,
        accounts: [{ id: 123, login: 456 }],
      },
    });
    const { getSettings } = await import("../src/storage/accounts");
    await expect(getSettings()).resolves.toEqual({
      version: 2,
      accounts: [],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- tests/accounts.test.ts`
Expected: FAIL with "Cannot find module '../src/storage/accounts'".

- [ ] **Step 3: Implement `src/storage/accounts.ts` (schemas + CRUD only)**

Create `src/storage/accounts.ts`:

```ts
import { z } from "zod";

const SETTINGS_KEY = "settings";

const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({
    login: z.string(),
    type: z.enum(["User", "Organization"]),
    avatarUrl: z.string().url().nullable(),
  }),
  repositorySelection: z.enum(["all", "selected"]),
  repoFullNames: z.array(z.string()).nullable(),
});

const accountSchema = z.object({
  id: z.string(),
  login: z.string(),
  avatarUrl: z.string().url().nullable(),
  token: z.string(),
  createdAt: z.number(),
  installations: z.array(installationSchema),
  installationsRefreshedAt: z.number(),
  invalidated: z.boolean().default(false),
  invalidatedReason: z
    .enum(["revoked", "expired", "unknown"])
    .nullable()
    .default(null),
});

const extensionSettingsSchema = z.object({
  version: z.literal(2),
  accounts: z.array(accountSchema),
});

export type Installation = z.infer<typeof installationSchema>;
export type Account = z.infer<typeof accountSchema>;
export type ExtensionSettings = z.infer<typeof extensionSettingsSchema>;

const EMPTY_SETTINGS: ExtensionSettings = { version: 2, accounts: [] };

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const parsed = extensionSettingsSchema.safeParse(result[SETTINGS_KEY]);
  return parsed.success ? parsed.data : EMPTY_SETTINGS;
}

async function writeSettings(settings: ExtensionSettings): Promise<void> {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function listAccounts(): Promise<Account[]> {
  const settings = await getSettings();
  return [...settings.accounts].sort((a, b) => a.createdAt - b.createdAt);
}

export async function addAccount(account: Account): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 2,
    accounts: [...settings.accounts, account],
  };
  await writeSettings(next);
}

export async function removeAccount(id: string): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 2,
    accounts: settings.accounts.filter((account) => account.id !== id),
  };
  await writeSettings(next);
}

export async function replaceInstallations(
  accountId: string,
  installations: Installation[],
): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 2,
    accounts: settings.accounts.map((account) =>
      account.id === accountId
        ? {
            ...account,
            installations,
            installationsRefreshedAt: Date.now(),
          }
        : account,
    ),
  };
  await writeSettings(next);
}

export async function markAccountInvalidated(
  accountId: string,
  reason: "revoked" | "expired" | "unknown",
): Promise<void> {
  const settings = await getSettings();
  const next: ExtensionSettings = {
    version: 2,
    accounts: settings.accounts.map((account) =>
      account.id === accountId
        ? { ...account, invalidated: true, invalidatedReason: reason }
        : account,
    ),
  };
  await writeSettings(next);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- tests/accounts.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add src/storage/accounts.ts tests/accounts.test.ts
git commit -m "feat(storage): add accounts storage module with zod schemas and CRUD"
```

---

## Task 3: `resolveAccountForRepo`

Add the runtime resolution helper that the content script will call. Algorithm per spec §4.3.

**Files:**
- Modify: `src/storage/accounts.ts`
- Modify: `tests/accounts.test.ts`

- [ ] **Step 1: Write the failing table-driven tests**

Append to `tests/accounts.test.ts`:

```ts
describe("resolveAccountForRepo", () => {
  async function seedAccounts(accounts: unknown[]) {
    browserMock.browser.storage.local.get.mockResolvedValue({
      settings: { version: 2, accounts },
    });
  }

  function makeAccount(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "acc",
      login: "hon454",
      avatarUrl: null,
      token: "ghu_abc",
      createdAt: 1,
      installations: [],
      installationsRefreshedAt: 1,
      invalidated: false,
      invalidatedReason: null,
      ...overrides,
    };
  }

  it("returns null when no account has a matching installation", async () => {
    await seedAccounts([makeAccount()]);
    const { resolveAccountForRepo } = await import("../src/storage/accounts");
    await expect(
      resolveAccountForRepo("cinev", "shotloom"),
    ).resolves.toBeNull();
  });

  it("matches via an all-repos installation on the same owner", async () => {
    await seedAccounts([
      makeAccount({
        installations: [
          {
            id: 1,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "all",
            repoFullNames: null,
          },
        ],
      }),
    ]);
    const { resolveAccountForRepo } = await import("../src/storage/accounts");
    const account = await resolveAccountForRepo("cinev", "shotloom");
    expect(account?.login).toBe("hon454");
  });

  it("matches selected installations by full name case-insensitively", async () => {
    await seedAccounts([
      makeAccount({
        installations: [
          {
            id: 1,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
            repoFullNames: ["CINEV/Shotloom"],
          },
        ],
      }),
    ]);
    const { resolveAccountForRepo } = await import("../src/storage/accounts");
    const account = await resolveAccountForRepo("cinev", "shotloom");
    expect(account).not.toBeNull();
  });

  it("does not match selected installations when repo is absent", async () => {
    await seedAccounts([
      makeAccount({
        installations: [
          {
            id: 1,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "selected",
            repoFullNames: ["cinev/landing"],
          },
        ],
      }),
    ]);
    const { resolveAccountForRepo } = await import("../src/storage/accounts");
    await expect(
      resolveAccountForRepo("cinev", "shotloom"),
    ).resolves.toBeNull();
  });

  it("skips invalidated accounts", async () => {
    await seedAccounts([
      makeAccount({
        invalidated: true,
        invalidatedReason: "revoked",
        installations: [
          {
            id: 1,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "all",
            repoFullNames: null,
          },
        ],
      }),
    ]);
    const { resolveAccountForRepo } = await import("../src/storage/accounts");
    await expect(
      resolveAccountForRepo("cinev", "shotloom"),
    ).resolves.toBeNull();
  });

  it("returns the earliest matching account when multiple accounts match", async () => {
    await seedAccounts([
      makeAccount({
        id: "later",
        login: "hon454-work",
        createdAt: 10,
        installations: [
          {
            id: 2,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "all",
            repoFullNames: null,
          },
        ],
      }),
      makeAccount({
        id: "earlier",
        login: "hon454",
        createdAt: 1,
        installations: [
          {
            id: 1,
            account: { login: "cinev", type: "Organization", avatarUrl: null },
            repositorySelection: "all",
            repoFullNames: null,
          },
        ],
      }),
    ]);
    const { resolveAccountForRepo } = await import("../src/storage/accounts");
    const account = await resolveAccountForRepo("cinev", "shotloom");
    expect(account?.id).toBe("earlier");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- tests/accounts.test.ts`
Expected: FAIL with "resolveAccountForRepo is not a function" or module export missing.

- [ ] **Step 3: Add `resolveAccountForRepo` to `src/storage/accounts.ts`**

Append at the bottom of the file:

```ts
export async function resolveAccountForRepo(
  owner: string,
  repo: string,
): Promise<Account | null> {
  const normalizedOwner = owner.toLowerCase();
  const normalizedRepo = repo.toLowerCase();
  const normalizedFullName = `${normalizedOwner}/${normalizedRepo}`;

  const accounts = await listAccounts();
  for (const account of accounts) {
    if (account.invalidated) {
      continue;
    }
    for (const installation of account.installations) {
      if (installation.account.login.toLowerCase() !== normalizedOwner) {
        continue;
      }
      if (installation.repositorySelection === "all") {
        return account;
      }
      const fullNames = installation.repoFullNames ?? [];
      if (fullNames.some((name) => name.toLowerCase() === normalizedFullName)) {
        return account;
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- tests/accounts.test.ts`
Expected: PASS (all 13).

- [ ] **Step 5: Commit**

```bash
git add src/storage/accounts.ts tests/accounts.test.ts
git commit -m "feat(storage): add resolveAccountForRepo with installation matching"
```

---

## Task 4: Auth — device flow initiate and poll

Add the first half of `src/github/auth.ts`: device code initiation, access-token polling with the three poll "continue" errors and two terminal errors, and the `slow_down` interval bump. Pagination and `/user/installations` are in Task 5.

**Files:**
- Create: `src/github/auth.ts`
- Create: `tests/auth.test.ts`
- Create: `tests/fixtures/github-api/device-code-init.json`
- Create: `tests/fixtures/github-api/access-token-pending.json`
- Create: `tests/fixtures/github-api/access-token-slow-down.json`
- Create: `tests/fixtures/github-api/access-token-expired.json`
- Create: `tests/fixtures/github-api/access-token-denied.json`
- Create: `tests/fixtures/github-api/access-token-success.json`

- [ ] **Step 1: Create fixtures**

`tests/fixtures/github-api/device-code-init.json`:

```json
{
  "device_code": "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900,
  "interval": 5
}
```

`tests/fixtures/github-api/access-token-pending.json`:

```json
{ "error": "authorization_pending" }
```

`tests/fixtures/github-api/access-token-slow-down.json`:

```json
{ "error": "slow_down", "interval": 10 }
```

`tests/fixtures/github-api/access-token-expired.json`:

```json
{ "error": "expired_token" }
```

`tests/fixtures/github-api/access-token-denied.json`:

```json
{ "error": "access_denied" }
```

`tests/fixtures/github-api/access-token-success.json`:

```json
{
  "access_token": "ghu_exampletoken",
  "token_type": "bearer",
  "scope": ""
}
```

- [ ] **Step 2: Write the failing tests for device flow poll states**

Create `tests/auth.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeviceFlowError,
  initiateDeviceFlow,
  pollForAccessToken,
} from "../src/github/auth";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/github-api/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("initiateDeviceFlow", () => {
  it("posts client_id to /login/device/code and returns parsed payload", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(fixture("device-code-init.json")));
    const result = await initiateDeviceFlow({ clientId: "Iv1.test" });
    expect(result.userCode).toBe("WDJB-MJHT");
    expect(result.deviceCode).toBe(
      "3584d83530557fdd1f46af8289938c8ef79f9dc5",
    );
    expect(result.interval).toBe(5);
    expect(result.expiresIn).toBe(900);
    expect(result.verificationUri).toBe("https://github.com/login/device");
    const [[url, init]] = fetchMock.mock.calls;
    expect(url).toBe("https://github.com/login/device/code");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Accept: "application/json" });
    expect(String(init?.body)).toContain("client_id=Iv1.test");
  });
});

describe("pollForAccessToken", () => {
  it("returns the access token on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("access-token-success.json")),
    );
    const result = await pollForAccessToken({
      clientId: "Iv1.test",
      deviceCode: "abc",
    });
    expect(result).toEqual({ status: "success", accessToken: "ghu_exampletoken" });
  });

  it("returns a pending status when authorization_pending", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("access-token-pending.json")),
    );
    const result = await pollForAccessToken({
      clientId: "Iv1.test",
      deviceCode: "abc",
    });
    expect(result).toEqual({ status: "pending" });
  });

  it("returns a slow_down status with the new interval", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("access-token-slow-down.json")),
    );
    const result = await pollForAccessToken({
      clientId: "Iv1.test",
      deviceCode: "abc",
    });
    expect(result).toEqual({ status: "slow_down", interval: 10 });
  });

  it("throws a terminal DeviceFlowError for expired_token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("access-token-expired.json")),
    );
    await expect(
      pollForAccessToken({ clientId: "Iv1.test", deviceCode: "abc" }),
    ).rejects.toBeInstanceOf(DeviceFlowError);
    await expect(
      pollForAccessToken({ clientId: "Iv1.test", deviceCode: "abc" }),
    ).rejects.toMatchObject({ code: "expired_token" });
  });

  it("throws a terminal DeviceFlowError for access_denied", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("access-token-denied.json")),
    );
    await expect(
      pollForAccessToken({ clientId: "Iv1.test", deviceCode: "abc" }),
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("throws a terminal DeviceFlowError for device_flow_disabled", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "device_flow_disabled" }),
    );
    await expect(
      pollForAccessToken({ clientId: "Iv1.test", deviceCode: "abc" }),
    ).rejects.toMatchObject({ code: "device_flow_disabled" });
  });

  it("throws a network error wrapped in DeviceFlowError on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("server down", { status: 503 }),
    );
    await expect(
      pollForAccessToken({ clientId: "Iv1.test", deviceCode: "abc" }),
    ).rejects.toMatchObject({ code: "network_error" });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test -- tests/auth.test.ts`
Expected: FAIL with "Cannot find module '../src/github/auth'".

- [ ] **Step 4: Implement the device flow portion of `src/github/auth.ts`**

Create `src/github/auth.ts`:

```ts
import { z } from "zod";

export type DeviceFlowErrorCode =
  | "expired_token"
  | "access_denied"
  | "device_flow_disabled"
  | "unsupported_grant_type"
  | "incorrect_client_credentials"
  | "incorrect_device_code"
  | "network_error"
  | "invalid_response";

export class DeviceFlowError extends Error {
  constructor(
    public readonly code: DeviceFlowErrorCode,
    message?: string,
  ) {
    super(message ?? `Device flow error: ${code}`);
    this.name = "DeviceFlowError";
  }
}

const deviceCodeInitSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().url(),
  expires_in: z.number(),
  interval: z.number(),
});

export type DeviceFlowInit = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export async function initiateDeviceFlow(input: {
  clientId: string;
  signal?: AbortSignal;
}): Promise<DeviceFlowInit> {
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ client_id: input.clientId }).toString(),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new DeviceFlowError(
      "network_error",
      `Device code request failed with status ${response.status}.`,
    );
  }
  const payload = deviceCodeInitSchema.safeParse(await response.json());
  if (!payload.success) {
    throw new DeviceFlowError(
      "invalid_response",
      "Malformed device code response from GitHub.",
    );
  }
  const verificationUri = payload.data.verification_uri;
  const verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(
    payload.data.user_code,
  )}`;
  return {
    deviceCode: payload.data.device_code,
    userCode: payload.data.user_code,
    verificationUri,
    verificationUriComplete,
    expiresIn: payload.data.expires_in,
    interval: payload.data.interval,
  };
}

const accessTokenResponseSchema = z.union([
  z.object({
    access_token: z.string(),
    token_type: z.string(),
    scope: z.string().optional(),
  }),
  z.object({
    error: z.string(),
    error_description: z.string().optional(),
    interval: z.number().optional(),
  }),
]);

export type AccessTokenPollResult =
  | { status: "success"; accessToken: string }
  | { status: "pending" }
  | { status: "slow_down"; interval: number };

const TERMINAL_POLL_ERRORS: DeviceFlowErrorCode[] = [
  "expired_token",
  "access_denied",
  "device_flow_disabled",
  "unsupported_grant_type",
  "incorrect_client_credentials",
  "incorrect_device_code",
];

export async function pollForAccessToken(input: {
  clientId: string;
  deviceCode: string;
  signal?: AbortSignal;
}): Promise<AccessTokenPollResult> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      device_code: input.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new DeviceFlowError(
      "network_error",
      `Access token request failed with status ${response.status}.`,
    );
  }
  const payload = accessTokenResponseSchema.safeParse(await response.json());
  if (!payload.success) {
    throw new DeviceFlowError(
      "invalid_response",
      "Malformed access token response from GitHub.",
    );
  }

  if ("access_token" in payload.data) {
    return { status: "success", accessToken: payload.data.access_token };
  }

  if (payload.data.error === "authorization_pending") {
    return { status: "pending" };
  }

  if (payload.data.error === "slow_down") {
    return {
      status: "slow_down",
      interval: payload.data.interval ?? 0,
    };
  }

  if ((TERMINAL_POLL_ERRORS as string[]).includes(payload.data.error)) {
    throw new DeviceFlowError(
      payload.data.error as DeviceFlowErrorCode,
      payload.data.error_description,
    );
  }

  throw new DeviceFlowError(
    "invalid_response",
    `Unrecognized device flow error: ${payload.data.error}`,
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- tests/auth.test.ts`
Expected: PASS (all device-flow-related tests).

- [ ] **Step 6: Commit**

```bash
git add src/github/auth.ts tests/auth.test.ts tests/fixtures/github-api/
git commit -m "feat(github): add device flow initiate and poll helpers"
```

---

## Task 5: Auth — `/user` and installations fetch with pagination

Extend `src/github/auth.ts` with `fetchAuthenticatedUser`, `fetchUserInstallations`, and `fetchInstallationRepositories`. Honor `Link: rel="next"` pagination with `per_page=100` and a 10-page ceiling, per spec §4.4.

**Files:**
- Modify: `src/github/auth.ts`
- Modify: `tests/auth.test.ts`
- Create: `tests/fixtures/github-api/user.json`
- Create: `tests/fixtures/github-api/user-installations.json`
- Create: `tests/fixtures/github-api/installation-repositories.json`

- [ ] **Step 1: Create fixtures**

`tests/fixtures/github-api/user.json`:

```json
{
  "login": "hon454",
  "avatar_url": "https://avatars.githubusercontent.com/u/123?v=4",
  "id": 123
}
```

`tests/fixtures/github-api/user-installations.json`:

```json
{
  "total_count": 2,
  "installations": [
    {
      "id": 12345,
      "account": {
        "login": "hon454",
        "type": "User",
        "avatar_url": "https://avatars.githubusercontent.com/u/123?v=4"
      },
      "repository_selection": "all"
    },
    {
      "id": 67890,
      "account": {
        "login": "cinev",
        "type": "Organization",
        "avatar_url": "https://avatars.githubusercontent.com/u/456?v=4"
      },
      "repository_selection": "selected"
    }
  ]
}
```

`tests/fixtures/github-api/installation-repositories.json`:

```json
{
  "total_count": 2,
  "repositories": [
    { "full_name": "cinev/shotloom" },
    { "full_name": "cinev/landing" }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/auth.test.ts`:

```ts
import {
  fetchAuthenticatedUser,
  fetchInstallationRepositories,
  fetchUserInstallations,
} from "../src/github/auth";

function paginatedResponse(body: unknown, linkNext?: string): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (linkNext) {
    headers["link"] = `<${linkNext}>; rel="next"`;
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

describe("fetchAuthenticatedUser", () => {
  it("parses login and avatar URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("user.json")),
    );
    const user = await fetchAuthenticatedUser({ token: "ghu_abc" });
    expect(user.login).toBe("hon454");
    expect(user.avatarUrl).toBe(
      "https://avatars.githubusercontent.com/u/123?v=4",
    );
  });
});

describe("fetchUserInstallations", () => {
  it("returns installations with camelCase fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("user-installations.json")),
    );
    const installations = await fetchUserInstallations({ token: "ghu_abc" });
    expect(installations).toHaveLength(2);
    expect(installations[0]).toMatchObject({
      id: 12345,
      repositorySelection: "all",
    });
    expect(installations[0].account.login).toBe("hon454");
  });
});

describe("fetchInstallationRepositories", () => {
  it("returns an array of full_name strings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(fixture("installation-repositories.json")),
    );
    const names = await fetchInstallationRepositories({
      token: "ghu_abc",
      installationId: 67890,
    });
    expect(names).toEqual(["cinev/shotloom", "cinev/landing"]);
  });

  it("follows pagination up to the 10-page ceiling", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (let page = 1; page <= 10; page++) {
      fetchMock.mockResolvedValueOnce(
        paginatedResponse(
          {
            total_count: 1,
            repositories: [{ full_name: `cinev/repo-${page}` }],
          },
          `https://api.github.com/user/installations/1/repositories?page=${page + 1}&per_page=100`,
        ),
      );
    }
    const names = await fetchInstallationRepositories({
      token: "ghu_abc",
      installationId: 1,
    });
    expect(names).toHaveLength(10);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("throws on non-ok responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }),
    );
    await expect(
      fetchInstallationRepositories({ token: "ghu_abc", installationId: 1 }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test -- tests/auth.test.ts`
Expected: FAIL (missing exports `fetchAuthenticatedUser`, `fetchUserInstallations`, `fetchInstallationRepositories`).

- [ ] **Step 4: Append implementations to `src/github/auth.ts`**

Append at the bottom of `src/github/auth.ts`:

```ts
const githubUserSchema = z.object({
  login: z.string(),
  avatar_url: z.string().url().nullable().optional(),
});

export type AuthenticatedUser = {
  login: string;
  avatarUrl: string | null;
};

export async function fetchAuthenticatedUser(input: {
  token: string;
  signal?: AbortSignal;
}): Promise<AuthenticatedUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: createAuthHeaders(input.token),
    signal: input.signal,
  });
  if (!response.ok) {
    throw new Error(`GET /user failed with status ${response.status}.`);
  }
  const payload = githubUserSchema.parse(await response.json());
  return {
    login: payload.login,
    avatarUrl: payload.avatar_url ?? null,
  };
}

const apiInstallationAccountSchema = z.object({
  login: z.string(),
  type: z.enum(["User", "Organization", "Bot"]),
  avatar_url: z.string().url().nullable().optional(),
});

const apiInstallationSchema = z.object({
  id: z.number(),
  account: apiInstallationAccountSchema,
  repository_selection: z.enum(["all", "selected"]),
});

const userInstallationsSchema = z.object({
  total_count: z.number(),
  installations: z.array(apiInstallationSchema),
});

export type ApiInstallation = {
  id: number;
  account: {
    login: string;
    type: "User" | "Organization";
    avatarUrl: string | null;
  };
  repositorySelection: "all" | "selected";
};

const MAX_INSTALLATION_PAGES = 10;

export async function fetchUserInstallations(input: {
  token: string;
  signal?: AbortSignal;
}): Promise<ApiInstallation[]> {
  const results: ApiInstallation[] = [];
  let url: string | null =
    "https://api.github.com/user/installations?per_page=100";
  for (let page = 0; page < MAX_INSTALLATION_PAGES && url != null; page++) {
    const response = await fetch(url, {
      headers: createAuthHeaders(input.token),
      signal: input.signal,
    });
    if (!response.ok) {
      throw new Error(
        `GET /user/installations failed with status ${response.status}.`,
      );
    }
    const payload = userInstallationsSchema.parse(await response.json());
    for (const installation of payload.installations) {
      if (installation.account.type === "Bot") {
        continue;
      }
      results.push({
        id: installation.id,
        account: {
          login: installation.account.login,
          type: installation.account.type as "User" | "Organization",
          avatarUrl: installation.account.avatar_url ?? null,
        },
        repositorySelection: installation.repository_selection,
      });
    }
    url = parseNextLink(response.headers.get("link"));
  }
  return results;
}

const installationRepositoriesSchema = z.object({
  total_count: z.number(),
  repositories: z.array(z.object({ full_name: z.string() })),
});

export async function fetchInstallationRepositories(input: {
  token: string;
  installationId: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const results: string[] = [];
  let url: string | null = `https://api.github.com/user/installations/${input.installationId}/repositories?per_page=100`;
  for (let page = 0; page < MAX_INSTALLATION_PAGES && url != null; page++) {
    const response = await fetch(url, {
      headers: createAuthHeaders(input.token),
      signal: input.signal,
    });
    if (!response.ok) {
      throw new Error(
        `GET /user/installations/${input.installationId}/repositories failed with status ${response.status}.`,
      );
    }
    const payload = installationRepositoriesSchema.parse(
      await response.json(),
    );
    for (const repository of payload.repositories) {
      results.push(repository.full_name);
    }
    url = parseNextLink(response.headers.get("link"));
  }
  return results;
}

function createAuthHeaders(token: string): Headers {
  return new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  });
}

function parseNextLink(header: string | null): string | null {
  if (header == null) {
    return null;
  }
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) {
      return match[1];
    }
  }
  return null;
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- tests/auth.test.ts`
Expected: PASS (all auth tests).

- [ ] **Step 6: Commit**

```bash
git add src/github/auth.ts tests/auth.test.ts tests/fixtures/github-api/
git commit -m "feat(github): add user and installations fetches with pagination"
```

---

## Task 6: Reviewer summary result gains a `status` field

The banner aggregator needs a structured signal from each reviewer-row attempt. Keep `fetchPullReviewerSummary`'s existing data shape and add a `status` that callers in the content script can route to the banner. This change is small and kept separate so the API-layer copy rewrite in Task 7 stays focused.

**Files:**
- Modify: `src/github/api.ts`
- Modify: `tests/api.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/api.test.ts`, in a new `describe` block near the other `fetchPullReviewerSummary` tests:

```ts
describe("fetchPullReviewerSummary status", () => {
  it("returns status 'ok' on success", async () => {
    const pullBody = {
      user: { login: "hon454" },
      requested_reviewers: [],
      requested_teams: [],
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(pullBody), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const summary = await fetchPullReviewerSummary({
      owner: "hon454",
      repo: "demo",
      pullNumber: "1",
      githubToken: null,
    });
    expect(summary.status).toBe("ok");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- tests/api.test.ts`
Expected: FAIL (property `status` missing on `PullReviewerSummary`).

- [ ] **Step 3: Add `status: "ok"` to the returned summary**

In `src/github/api.ts`, locate the `PullReviewerSummary` type (currently defined around line 63). Replace:

```ts
export type PullReviewerSummary = {
  requestedUsers: string[];
  requestedTeams: string[];
  completedReviews: CompletedReview[];
};
```

with:

```ts
export type PullReviewerSummaryStatus =
  | "ok"
  | "no-coverage"
  | "network-error"
  | "rate-limited";

export type PullReviewerSummary = {
  status: PullReviewerSummaryStatus;
  requestedUsers: string[];
  requestedTeams: string[];
  completedReviews: CompletedReview[];
};
```

Then locate the `return { requestedUsers, requestedTeams, completedReviews };` block at the bottom of `fetchPullReviewerSummary` and replace it with:

```ts
  return {
    status: "ok",
    requestedUsers: pull.requested_reviewers.map((reviewer) => reviewer.login),
    requestedTeams: pull.requested_teams.map((team) => team.slug),
    completedReviews,
  };
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- tests/api.test.ts`
Expected: PASS including the new status test. Existing `fetchPullReviewerSummary` cases continue to pass because `PullReviewerSummary` is constructed here only.

- [ ] **Step 5: Commit**

```bash
git add src/github/api.ts tests/api.test.ts
git commit -m "feat(api): add status field to PullReviewerSummary"
```

---

## Task 7: API — App-aware error copy and account-based validators

Rewrite `describeGitHubEndpointError` to drop every PAT / SSO mention and use App-aware language: 401 becomes "Sign in again" and 403/404 no longer reference the `repo` scope. Update `validateGitHubToken` to accept an `Account` and update `validateGitHubRepositoryAccess` to accept `Account | null` so the diagnostics panel can call either a matched account or the no-token path without going through `token-scopes.ts`.

**Files:**
- Modify: `src/github/api.ts`
- Modify: `tests/api.test.ts`
- Modify: `tests/fixtures/repository-validation-matrix.json`

- [ ] **Step 1: Update fixtures to drop PAT/SSO language**

Open `tests/fixtures/repository-validation-matrix.json`. For every case whose `expected.messageIncludes` contains `"SSO"`, `"'repo' scope"`, or `"public_repo"`, replace those strings. Use App-aware substitutes from the table below; keep every other field unchanged.

| Old substring | Replacement substring |
|---|---|
| `"'repo' scope"` | `"GitHub App"` |
| `"public_repo"` | `"install the GitHub App"` |
| `"SSO"` | `"Sign in again"` |
| `"Pull requests: Read"` | `"Pull requests: Read"` (keep — this is the App permission name) |

After the edit, every case's `messageIncludes` must be free of the three PAT-era strings. Run this check to confirm:

Run: `grep -nE "(SSO|'repo' scope|public_repo)" tests/fixtures/repository-validation-matrix.json`
Expected: no matches.

- [ ] **Step 2: Update `tests/api.test.ts` assertions**

Open `tests/api.test.ts`. Replace every `expect(...).toContain("SSO"...)`, `expect(...).toContain("repo scope"...)`, and related PAT wording with App-aware assertions. Concretely:

Find the existing assertion block that contains `expect(message).toBe("Saved token is invalid or expired.")` and replace the body of that `it(...)` test with:

```ts
    const message = describeGitHubApiError(new GitHubApiError(401), {
      githubToken: "ghu_example",
    });
    expect(message).toBe("Sign in again — the account's access was rejected by GitHub.");
```

Find the 403 saved-token test and replace its assertion with:

```ts
    expect(message).toContain("GitHub App");
    expect(message).toContain("install the GitHub App");
    expect(message).not.toContain("repo scope");
    expect(message).not.toContain("SSO");
```

Find the 404 saved-token test and replace its assertion with:

```ts
    expect(message).toContain("not covered by any installation");
    expect(message).not.toContain("repo scope");
```

If there is a test that specifically asserts the `"Configure SSO"` URL, delete that assertion; do not replace it.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- tests/api.test.ts`
Expected: FAIL with mismatched message strings (this is the TDD red state).

- [ ] **Step 4: Rewrite `describeGitHubEndpointError` in `src/github/api.ts`**

Replace the `describeGitHubEndpointError` function (currently lines ~488–538) with:

```ts
function describeGitHubEndpointError(
  error: GitHubApiError,
  auth: GitHubAuthContext,
): string {
  const endpointLabel = formatEndpointLabel(error.endpoint);
  const rateLimitSuffix = formatRateLimitSuffix(error.rateLimit);

  if (auth.githubToken) {
    if (error.status === 401) {
      if (error.endpoint == null || error.endpoint.path === "/rate_limit") {
        return "Sign in again — the account's access was rejected by GitHub.";
      }
      return `Sign in again — ${endpointLabel} was rejected by GitHub.`;
    }

    if (isRateLimitError(error)) {
      return `${endpointLabel} hit GitHub's API rate limit${rateLimitSuffix}.`;
    }

    if (error.status === 403) {
      return `GitHub denied ${endpointLabel}. The GitHub App needs access to this repository — install the GitHub App on the owner account or add this repository to the existing installation.`;
    }

    if (error.status === 404) {
      return `${endpointLabel} is not covered by any installation of this GitHub App. Install the App on the repository owner or add the repository to the existing installation.`;
    }
  } else {
    if (isRateLimitError(error)) {
      return `${endpointLabel} hit GitHub's unauthenticated rate limit${rateLimitSuffix}. Public repositories usually work without signing in until the rate limit is exhausted; sign in for higher limits.`;
    }

    if (error.status === 401) {
      return `${endpointLabel} requires authentication. Public repositories usually work without signing in, so this repository or pull request may be private or access-restricted.`;
    }

    if (error.status === 403) {
      return `${endpointLabel} was denied without a signed-in account. Public repositories usually work without signing in; sign in for private repositories or higher API limits.`;
    }

    if (error.status === 404) {
      return `${endpointLabel} was not accessible without a signed-in account. Public repositories usually work without signing in, so the repository or pull request may be private, deleted, or permission-gated.`;
    }
  }

  if (error.details) {
    return `${endpointLabel} failed: ${error.details}`;
  }
  return `${endpointLabel} failed with status ${error.status}.`;
}
```

- [ ] **Step 5: Replace `validateGitHubToken` with an account-based variant**

In `src/github/api.ts`, replace the existing `validateGitHubToken` function with:

```ts
export async function validateAccountToken(
  account: { token: string } | null,
): Promise<TokenValidationResult> {
  if (account == null) {
    return {
      ok: false,
      message: "No account provided — sign in with GitHub from the options page.",
    };
  }
  const response = await fetch("https://api.github.com/rate_limit", {
    headers: createGitHubHeaders(account.token),
  });
  if (!response.ok) {
    const error = await createGitHubApiError(response, {
      name: "pulls-list",
      method: "GET",
      path: "/rate_limit",
    });
    return {
      ok: false,
      message: describeGitHubApiError(error, { githubToken: account.token }),
    };
  }
  const payload = rateLimitSchema.parse(await response.json());
  return {
    ok: true,
    limit: payload.rate.limit,
    remaining: payload.rate.remaining,
  };
}
```

And change `validateGitHubRepositoryAccess`'s signature to accept `account: { token: string } | null` instead of `token: string | null`. Internally, derive `token` as `account?.token ?? null` and reuse the existing body:

```ts
export async function validateGitHubRepositoryAccess(
  account: { token: string } | null,
  repository: string,
): Promise<RepositoryValidationResult> {
  const token = account?.token ?? null;
  // existing body unchanged from here — use `token` where the previous parameter was used.
```

Delete the now-unused `export`s of `validateGitHubToken` if the replacement name differs; alternatively, keep the name `validateGitHubToken` and change the signature to `validateGitHubToken(account)` — pick one and update imports consistently. This plan proceeds with `validateAccountToken` as the new name.

- [ ] **Step 6: Update call sites in the remaining file (if any)**

Run: `grep -n "validateGitHubToken\b" src/ entrypoints/ tests/`
Expected: only references in `entrypoints/options/options-page.tsx` and `tests/options-page.test.ts`, which are rewritten in Tasks 15–18. Leave them broken for now — the typecheck in Task 18 is the gate.

- [ ] **Step 7: Run tests**

Run: `pnpm test -- tests/api.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/github/api.ts tests/api.test.ts tests/fixtures/repository-validation-matrix.json
git commit -m "refactor(api): replace PAT copy with GitHub App wording and account-based validators"
```

---

## Task 8: Reviewer feature drops error rendering

Remove `renderError` from `src/features/reviewers/dom.ts`, drop the error-only branches from `view-model.ts`, and remove the call site in `index.ts`. Row-level failures become an empty mount + a banner signal; the banner is wired up later in Task 11.

**Files:**
- Modify: `src/features/reviewers/dom.ts`
- Modify: `src/features/reviewers/view-model.ts`
- Modify: `src/features/reviewers/index.ts`
- Modify: `tests/reviewer-dom.test.ts`
- Modify: `tests/reviewer-view-model.test.ts`

- [ ] **Step 1: Update `tests/reviewer-dom.test.ts` to drop the `renderError` test**

Open `tests/reviewer-dom.test.ts`. Remove any `it(...)` or `describe(...)` block that imports or asserts `renderError` / `ghpsr-status--error`. If the file contains a test named `"renders an error message"` or similar, delete it. If this leaves a stale import for `renderError`, remove that import too.

- [ ] **Step 2: Update `tests/reviewer-view-model.test.ts` similarly**

Open `tests/reviewer-view-model.test.ts` and remove assertions that depend on an error branch. There likely are none (the view-model is pure), so this step is often a no-op.

- [ ] **Step 3: Run the tests to confirm they still pass**

Run: `pnpm test -- tests/reviewer-dom.test.ts tests/reviewer-view-model.test.ts`
Expected: PASS.

- [ ] **Step 4: Edit `src/features/reviewers/dom.ts`**

Delete the `renderError` export (around lines 144–150):

```ts
export function renderError(mount: HTMLElement, message: string): void {
  const node = document.createElement("span");
  node.className = "ghpsr-status ghpsr-status--error";
  node.textContent = message;
  mount.replaceChildren(node);
  mount.title = message;
}
```

Delete these two style rules in the template string (around lines 88–90):

```text
    .ghpsr-status--error {
      color: var(--fgColor-danger, #cf222e);
    }
```

- [ ] **Step 5: Edit `src/features/reviewers/index.ts`**

Remove `renderError` from the import list. Replace the `catch (error) { renderError(mount, describeGitHubApiError(error, ...)); }` block with a call to a new `onRowFailure` callback that the content script will wire up in Task 11. The updated request factory becomes:

```ts
    const request = (async () => {
      const account = await resolveAccountForRepo(
        currentRoute!.owner,
        currentRoute!.repo,
      );
      const githubToken = account?.token ?? null;

      try {
        const summary = await fetchPullReviewerSummary({
          owner: currentRoute!.owner,
          repo: currentRoute!.repo,
          pullNumber,
          githubToken,
        });
        setCachedReviewerSummary(cacheKey, summary);
      } catch (error) {
        mount.replaceChildren();
        mount.removeAttribute("title");
        options?.onRowFailure?.({
          owner: currentRoute!.owner,
          repo: currentRoute!.repo,
          account,
          error,
        });
      } finally {
        inflightRequests.delete(cacheKey);
      }
    })();
```

Change the `bootReviewerListPage` signature to accept an `options` argument:

```ts
export type ReviewerBootOptions = {
  onRowFailure?: (signal: {
    owner: string;
    repo: string;
    account: Account | null;
    error: unknown;
  }) => void;
};

export function bootReviewerListPage(
  ctx: ContentScriptContext,
  options?: ReviewerBootOptions,
): void {
```

Replace `resolveTokenEntryForRepository` / `getStoredSettings` imports with:

```ts
import { resolveAccountForRepo, type Account } from "../../storage/accounts";
```

Also delete the `settingsCache` / `loadSettings` machinery and the `storageListener` branch that watches `changes.settings` — the account list is resolved freshly per row via `resolveAccountForRepo`. Replace the storage listener body with:

```ts
  const storageListener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
    changes,
    areaName,
  ) => {
    if (areaName === "local" && changes.settings) {
      clearReviewerCache();
      inflightRequests.clear();
      processRows();
    }
  };
```

Remove the `describeGitHubApiError` import since it is no longer used in this file.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: Tests in this file PASS; `tests/options-page.test.ts` may still fail because the options page is not yet migrated. That's expected — Task 18 fixes it.

- [ ] **Step 7: Commit**

```bash
git add src/features/reviewers/ tests/reviewer-dom.test.ts tests/reviewer-view-model.test.ts
git commit -m "refactor(reviewers): drop row-level error rendering and accept failure callback"
```

---

## Task 9: Banner aggregator (pure state module)

Implement the per-page-session aggregator that tracks uncovered orgs, rate-limit signals, and dismissal memory. Everything here is a pure module so tests are straightforward.

**Files:**
- Create: `src/features/access-banner/aggregator.ts`
- Create: `tests/access-banner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/access-banner.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBannerAggregator,
  formatBannerMessage,
} from "../src/features/access-banner/aggregator";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe("bannerAggregator", () => {
  it("starts empty", () => {
    const aggregator = createBannerAggregator({ pathname: "/cinev/shotloom/pulls" });
    expect(aggregator.getState()).toEqual({
      uncoveredOrgs: [],
      unauthRateLimited: false,
      dismissed: false,
    });
  });

  it("dedupes org entries case-insensitively", () => {
    const aggregator = createBannerAggregator({ pathname: "/x/pulls" });
    aggregator.reportUncoveredOwner("CINEV");
    aggregator.reportUncoveredOwner("cinev");
    aggregator.reportUncoveredOwner("cinev");
    expect(aggregator.getState().uncoveredOrgs).toEqual(["cinev"]);
  });

  it("flags an unauth rate limit", () => {
    const aggregator = createBannerAggregator({ pathname: "/x/pulls" });
    aggregator.reportUnauthRateLimit();
    expect(aggregator.getState().unauthRateLimited).toBe(true);
  });

  it("persists dismissal by pathname via sessionStorage", () => {
    const first = createBannerAggregator({ pathname: "/cinev/shotloom/pulls" });
    first.dismiss();
    const second = createBannerAggregator({ pathname: "/cinev/shotloom/pulls" });
    expect(second.getState().dismissed).toBe(true);
    const other = createBannerAggregator({ pathname: "/other/repo/pulls" });
    expect(other.getState().dismissed).toBe(false);
  });

  it("resets dismissal when the pathname changes", () => {
    const first = createBannerAggregator({ pathname: "/cinev/shotloom/pulls" });
    first.dismiss();
    const second = createBannerAggregator({ pathname: "/cinev/landing/pulls" });
    expect(second.getState().dismissed).toBe(false);
  });
});

describe("formatBannerMessage", () => {
  it("formats a single uncovered org", () => {
    const text = formatBannerMessage({
      uncoveredOrgs: ["cinev"],
      unauthRateLimited: false,
    });
    expect(text).toBe(
      "Add GitHub App access to @cinev to see reviewers on this page.",
    );
  });

  it("formats multiple uncovered orgs", () => {
    const text = formatBannerMessage({
      uncoveredOrgs: ["cinev", "acme", "beta"],
      unauthRateLimited: false,
    });
    expect(text).toBe(
      "Add GitHub App access to @cinev and 2 more organizations.",
    );
  });

  it("formats an unauth rate limit message when nothing else is reported", () => {
    const text = formatBannerMessage({
      uncoveredOrgs: [],
      unauthRateLimited: true,
    });
    expect(text).toBe(
      "You hit GitHub's unauthenticated rate limit.",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/access-banner.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the aggregator**

Create `src/features/access-banner/aggregator.ts`:

```ts
export type BannerState = {
  uncoveredOrgs: string[];
  unauthRateLimited: boolean;
  dismissed: boolean;
};

export type BannerAggregator = {
  getState(): BannerState;
  subscribe(listener: (state: BannerState) => void): () => void;
  reportUncoveredOwner(owner: string): void;
  reportUnauthRateLimit(): void;
  dismiss(): void;
};

export function createBannerAggregator(options: {
  pathname: string;
}): BannerAggregator {
  const dismissKey = `ghpsr:banner-dismissed:${options.pathname}`;
  const orgs = new Set<string>();
  let unauthRateLimited = false;
  let dismissed = readDismissed(dismissKey);
  const listeners = new Set<(state: BannerState) => void>();

  function snapshot(): BannerState {
    return {
      uncoveredOrgs: [...orgs],
      unauthRateLimited,
      dismissed,
    };
  }

  function emit(): void {
    const state = snapshot();
    listeners.forEach((listener) => listener(state));
  }

  return {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
      };
    },
    reportUncoveredOwner(owner) {
      const normalized = owner.toLowerCase();
      if (orgs.has(normalized)) {
        return;
      }
      orgs.add(normalized);
      emit();
    },
    reportUnauthRateLimit() {
      if (unauthRateLimited) {
        return;
      }
      unauthRateLimited = true;
      emit();
    },
    dismiss() {
      if (dismissed) {
        return;
      }
      dismissed = true;
      try {
        window.sessionStorage.setItem(dismissKey, "1");
      } catch {
        // sessionStorage access denied — ignore
      }
      emit();
    },
  };
}

function readDismissed(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function formatBannerMessage(state: {
  uncoveredOrgs: string[];
  unauthRateLimited: boolean;
}): string {
  if (state.uncoveredOrgs.length === 1) {
    return `Add GitHub App access to @${state.uncoveredOrgs[0]} to see reviewers on this page.`;
  }
  if (state.uncoveredOrgs.length > 1) {
    const [first, ...rest] = state.uncoveredOrgs;
    return `Add GitHub App access to @${first} and ${rest.length} more organization${rest.length === 1 ? "" : "s"}.`;
  }
  if (state.unauthRateLimited) {
    return "You hit GitHub's unauthenticated rate limit.";
  }
  return "";
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- tests/access-banner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/access-banner/aggregator.ts tests/access-banner.test.ts
git commit -m "feat(access-banner): add page-session aggregator for uncovered orgs"
```

---

## Task 10: Banner DOM

Inject a banner element just below the PR list header when the aggregator has something to show, and remove it when dismissed or the state clears. Keep this module DOM-only; aggregator state is passed in.

**Files:**
- Create: `src/features/access-banner/dom.ts`
- Modify: `tests/access-banner.test.ts`

- [ ] **Step 1: Add a DOM test**

Append to `tests/access-banner.test.ts`:

```ts
import { mountBanner } from "../src/features/access-banner/dom";

describe("banner DOM", () => {
  it("does not insert a banner when state is empty", () => {
    document.body.innerHTML = `<main><div class="gh-header"></div></main>`;
    const target = document.querySelector<HTMLElement>(".gh-header")!;
    const banner = mountBanner({
      insertAfter: target,
      installUrl: "https://github.com/apps/test-app/installations/new",
      optionsPageUrl: "chrome-extension://ext-id/options.html",
      onDismiss: () => {},
    });
    banner.update({ uncoveredOrgs: [], unauthRateLimited: false, dismissed: false });
    expect(document.querySelector("[data-ghpsr-banner]")).toBeNull();
  });

  it("inserts the banner when an uncovered org is reported", () => {
    document.body.innerHTML = `<main><div class="gh-header"></div></main>`;
    const target = document.querySelector<HTMLElement>(".gh-header")!;
    const banner = mountBanner({
      insertAfter: target,
      installUrl: "https://github.com/apps/test-app/installations/new",
      optionsPageUrl: "chrome-extension://ext-id/options.html",
      onDismiss: () => {},
    });
    banner.update({
      uncoveredOrgs: ["cinev"],
      unauthRateLimited: false,
      dismissed: false,
    });
    const el = document.querySelector("[data-ghpsr-banner]");
    expect(el?.textContent).toContain("@cinev");
  });

  it("removes the banner when dismissed", () => {
    document.body.innerHTML = `<main><div class="gh-header"></div></main>`;
    const target = document.querySelector<HTMLElement>(".gh-header")!;
    const banner = mountBanner({
      insertAfter: target,
      installUrl: "https://github.com/apps/test-app/installations/new",
      optionsPageUrl: "chrome-extension://ext-id/options.html",
      onDismiss: () => {},
    });
    banner.update({
      uncoveredOrgs: ["cinev"],
      unauthRateLimited: false,
      dismissed: false,
    });
    banner.update({
      uncoveredOrgs: ["cinev"],
      unauthRateLimited: false,
      dismissed: true,
    });
    expect(document.querySelector("[data-ghpsr-banner]")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- tests/access-banner.test.ts`
Expected: FAIL (module `dom.ts` missing).

- [ ] **Step 3: Implement `src/features/access-banner/dom.ts`**

```ts
import type { BannerState } from "./aggregator";
import { formatBannerMessage } from "./aggregator";

const BANNER_ATTRIBUTE = "data-ghpsr-banner";

export type BannerMount = {
  update(state: BannerState): void;
  teardown(): void;
};

export function mountBanner(input: {
  insertAfter: HTMLElement;
  installUrl: string;
  optionsPageUrl: string;
  onDismiss: () => void;
}): BannerMount {
  let element: HTMLElement | null = null;

  function render(state: BannerState): void {
    const visible =
      !state.dismissed &&
      (state.uncoveredOrgs.length > 0 || state.unauthRateLimited);

    if (!visible) {
      element?.remove();
      element = null;
      return;
    }

    if (element == null) {
      element = document.createElement("div");
      element.setAttribute(BANNER_ATTRIBUTE, "true");
      element.style.cssText = [
        "margin: 12px 0",
        "padding: 12px 16px",
        "border-radius: 6px",
        "background: #ddf4ff",
        "color: #0969da",
        "display: flex",
        "gap: 12px",
        "align-items: center",
        "font-size: 13px",
      ].join(";");
      input.insertAfter.insertAdjacentElement("afterend", element);
    }

    element.innerHTML = "";

    const message = document.createElement("span");
    message.textContent = formatBannerMessage(state);
    element.append(message);

    if (state.uncoveredOrgs.length > 0) {
      const installLink = document.createElement("a");
      installLink.href = input.installUrl;
      installLink.target = "_blank";
      installLink.rel = "noreferrer";
      installLink.textContent =
        state.uncoveredOrgs.length === 1 ? "Install" : "Manage access";
      element.append(installLink);
    } else if (state.unauthRateLimited) {
      const signInLink = document.createElement("a");
      signInLink.href = input.optionsPageUrl;
      signInLink.target = "_blank";
      signInLink.rel = "noreferrer";
      signInLink.textContent = "Sign in";
      element.append(signInLink);
    }

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", () => input.onDismiss());
    element.append(dismissBtn);
  }

  return {
    update: render,
    teardown() {
      element?.remove();
      element = null;
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test -- tests/access-banner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/access-banner/dom.ts tests/access-banner.test.ts
git commit -m "feat(access-banner): render and dismiss banner DOM from aggregator state"
```

---

## Task 11: Access-banner feature index and content script rewrite

Wire the aggregator + DOM into the content script. Replace `entrypoints/content.ts` with one that boots both features and routes reviewer failures to the banner.

**Files:**
- Create: `src/features/access-banner/index.ts`
- Modify: `entrypoints/content.ts`

- [ ] **Step 1: Create the feature index**

Create `src/features/access-banner/index.ts`:

```ts
import type { ContentScriptContext } from "wxt/utils/content-script-context";

import { buildInstallAppUrl, getGitHubAppConfig } from "../../config/github-app";
import { parsePullListRoute } from "../../github/routes";

import { createBannerAggregator, type BannerAggregator } from "./aggregator";
import { mountBanner, type BannerMount } from "./dom";

export function bootAccessBanner(
  ctx: ContentScriptContext,
): BannerAggregator | null {
  const route = parsePullListRoute(window.location.pathname);
  if (route == null) {
    return null;
  }
  const aggregator = createBannerAggregator({
    pathname: window.location.pathname,
  });

  const optionsPageUrl = browser.runtime.getURL("options.html");
  const appConfig = getGitHubAppConfig();
  const installUrl = buildInstallAppUrl(appConfig.slug);

  let mount: BannerMount | null = null;

  function ensureMountTarget(): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>(".pr-toolbar") ??
      document.querySelector<HTMLElement>(".subnav") ??
      document.querySelector<HTMLElement>("main") ??
      null
    );
  }

  const unsubscribe = aggregator.subscribe((state) => {
    if (mount == null) {
      const target = ensureMountTarget();
      if (target == null) {
        return;
      }
      mount = mountBanner({
        insertAfter: target,
        installUrl,
        optionsPageUrl,
        onDismiss: () => aggregator.dismiss(),
      });
    }
    mount.update(state);
  });

  ctx.onInvalidated(() => {
    unsubscribe();
    mount?.teardown();
  });

  return aggregator;
}
```

- [ ] **Step 2: Rewrite `entrypoints/content.ts`**

Replace the file with:

```ts
import { bootAccessBanner } from "../src/features/access-banner";
import { bootReviewerListPage } from "../src/features/reviewers";

export default defineContentScript({
  matches: ["https://github.com/*/*"],
  runAt: "document_idle",
  main(ctx) {
    const aggregator = bootAccessBanner(ctx);
    bootReviewerListPage(ctx, {
      onRowFailure({ owner, account, error }) {
        if (aggregator == null) {
          return;
        }
        const status = extractStatus(error);
        if (status === 429 || (account == null && status === 403)) {
          aggregator.reportUnauthRateLimit();
          return;
        }
        if (status === 404 || status === 403 || account == null) {
          aggregator.reportUncoveredOwner(owner);
          return;
        }
        // 401 and other errors — still flag uncovered so the banner can guide the user.
        aggregator.reportUncoveredOwner(owner);
      },
    });
  },
});

function extractStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const value = (error as { status: unknown }).status;
    return typeof value === "number" ? value : null;
  }
  if (
    error &&
    typeof error === "object" &&
    "failures" in error &&
    Array.isArray((error as { failures: unknown }).failures)
  ) {
    const first = (error as { failures: Array<{ status?: number }> })
      .failures[0];
    return typeof first?.status === "number" ? first.status : null;
  }
  return null;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS (reviewers feature and content script now compile together).

- [ ] **Step 4: Run the full test suite (excluding the options-page test which is still stale)**

Run: `pnpm test -- --exclude tests/options-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/access-banner/index.ts entrypoints/content.ts
git commit -m "feat(content): wire access banner to reviewer row failures"
```

---

## Task 12: Device flow controller hook

Implement the React hook that the `AddAccountPanel` will consume. It owns the state machine (idle → initiating → waiting → fetchingInstallations → connected / error / expired), the polling interval (bumped on `slow_down`), and the expiry clock.

**Files:**
- Create: `entrypoints/options/device-flow-controller.ts`
- Create: `tests/device-flow-controller.test.ts`

- [ ] **Step 1: Write the failing hook tests**

Create `tests/device-flow-controller.test.ts`:

```ts
// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDeviceFlowController } from "../entrypoints/options/device-flow-controller";

vi.mock("../src/github/auth", () => ({
  DeviceFlowError: class DeviceFlowError extends Error {
    constructor(
      public readonly code: string,
      message?: string,
    ) {
      super(message ?? code);
    }
  },
  initiateDeviceFlow: vi.fn(),
  pollForAccessToken: vi.fn(),
  fetchAuthenticatedUser: vi.fn(),
  fetchUserInstallations: vi.fn(),
  fetchInstallationRepositories: vi.fn(),
}));

const auth = await import("../src/github/auth");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useDeviceFlowController", () => {
  it("starts idle", () => {
    const { result } = renderHook(() =>
      useDeviceFlowController({
        clientId: "Iv1.test",
        onConnected: vi.fn(),
      }),
    );
    expect(result.current.state.phase).toBe("idle");
  });

  it("transitions to waiting and then connected on success", async () => {
    (auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete:
        "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    (auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "pending",
    });
    (auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "success",
      accessToken: "ghu_token",
    });
    (auth.fetchAuthenticatedUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      login: "hon454",
      avatarUrl: null,
    });
    (auth.fetchUserInstallations as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const onConnected = vi.fn();
    const { result } = renderHook(() =>
      useDeviceFlowController({ clientId: "Iv1.test", onConnected }),
    );

    await act(async () => {
      result.current.start();
    });
    expect(result.current.state.phase).toBe("waiting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(onConnected).toHaveBeenCalled();
    expect(result.current.state.phase).toBe("connected");
  });

  it("bumps the interval on slow_down", async () => {
    (auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    (auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ status: "slow_down", interval: 10 })
      .mockResolvedValue({ status: "pending" });

    const { result } = renderHook(() =>
      useDeviceFlowController({ clientId: "Iv1.test", onConnected: vi.fn() }),
    );
    await act(async () => {
      result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.state.phase).toBe("waiting");
    expect(result.current.state.interval).toBeGreaterThanOrEqual(10);
  });

  it("transitions to expired when the clock passes expires_at", async () => {
    (auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 1,
      interval: 5,
    });
    (auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "pending",
    });
    const { result } = renderHook(() =>
      useDeviceFlowController({ clientId: "Iv1.test", onConnected: vi.fn() }),
    );
    await act(async () => {
      result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(result.current.state.phase).toBe("expired");
  });

  it("cancel returns to idle", async () => {
    (auth.initiateDeviceFlow as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: "https://github.com/login/device?user_code=ABCD-EFGH",
      expiresIn: 900,
      interval: 5,
    });
    (auth.pollForAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "pending",
    });

    const { result } = renderHook(() =>
      useDeviceFlowController({ clientId: "Iv1.test", onConnected: vi.fn() }),
    );
    await act(async () => {
      result.current.start();
    });
    await act(async () => {
      result.current.cancel();
    });
    expect(result.current.state.phase).toBe("idle");
  });
});
```

- [ ] **Step 2: Install `@testing-library/react`**

Run: `pnpm add -D @testing-library/react`
Expected: package added, lockfile updated.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test -- tests/device-flow-controller.test.ts`
Expected: FAIL (module `entrypoints/options/device-flow-controller` missing).

- [ ] **Step 4: Implement the hook**

Create `entrypoints/options/device-flow-controller.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";

import {
  addAccount,
  replaceInstallations,
  type Account,
  type Installation,
} from "../../src/storage/accounts";
import {
  DeviceFlowError,
  fetchAuthenticatedUser,
  fetchInstallationRepositories,
  fetchUserInstallations,
  initiateDeviceFlow,
  pollForAccessToken,
  type DeviceFlowInit,
} from "../../src/github/auth";

export type DeviceFlowState =
  | { phase: "idle" }
  | {
      phase: "initiating";
    }
  | {
      phase: "waiting";
      userCode: string;
      verificationUri: string;
      verificationUriComplete: string;
      interval: number;
      expiresAt: number;
    }
  | { phase: "fetching_installations" }
  | { phase: "connected"; accountId: string }
  | { phase: "expired" }
  | { phase: "denied" }
  | { phase: "fatal"; code: string; message: string };

export type DeviceFlowController = {
  state: DeviceFlowState;
  start(): void;
  cancel(): void;
};

export function useDeviceFlowController(input: {
  clientId: string;
  onConnected: (account: Account) => void;
}): DeviceFlowController {
  const [state, setState] = useState<DeviceFlowState>({ phase: "idle" });
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const intervalRef = useRef(5);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setState({ phase: "idle" });
  }, [clearTimer]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const runPollLoop = useCallback(
    (init: DeviceFlowInit, expiresAt: number) => {
      const scheduleNext = () => {
        if (cancelledRef.current) {
          return;
        }
        if (Date.now() >= expiresAt) {
          setState({ phase: "expired" });
          return;
        }
        timerRef.current = window.setTimeout(async () => {
          try {
            const result = await pollForAccessToken({
              clientId: input.clientId,
              deviceCode: init.deviceCode,
            });
            if (cancelledRef.current) {
              return;
            }
            if (result.status === "slow_down") {
              intervalRef.current = Math.max(
                intervalRef.current + 5,
                result.interval || intervalRef.current + 5,
              );
              setState({
                phase: "waiting",
                userCode: init.userCode,
                verificationUri: init.verificationUri,
                verificationUriComplete: init.verificationUriComplete,
                interval: intervalRef.current,
                expiresAt,
              });
              scheduleNext();
              return;
            }
            if (result.status === "pending") {
              scheduleNext();
              return;
            }
            setState({ phase: "fetching_installations" });
            await completeAccountConnect(result.accessToken, input.onConnected);
            setState({ phase: "connected", accountId: "pending" });
          } catch (error) {
            if (error instanceof DeviceFlowError) {
              if (error.code === "expired_token") {
                setState({ phase: "expired" });
                return;
              }
              if (error.code === "access_denied") {
                setState({ phase: "denied" });
                return;
              }
              setState({
                phase: "fatal",
                code: error.code,
                message: error.message,
              });
              return;
            }
            setState({
              phase: "fatal",
              code: "network_error",
              message: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }, intervalRef.current * 1000);
      };
      scheduleNext();
    },
    [input.clientId, input.onConnected],
  );

  const start = useCallback(() => {
    cancelledRef.current = false;
    intervalRef.current = 5;
    setState({ phase: "initiating" });
    void (async () => {
      try {
        const init = await initiateDeviceFlow({ clientId: input.clientId });
        intervalRef.current = init.interval;
        const expiresAt = Date.now() + init.expiresIn * 1000;
        setState({
          phase: "waiting",
          userCode: init.userCode,
          verificationUri: init.verificationUri,
          verificationUriComplete: init.verificationUriComplete,
          interval: init.interval,
          expiresAt,
        });
        runPollLoop(init, expiresAt);
      } catch (error) {
        setState({
          phase: "fatal",
          code: "network_error",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    })();
  }, [input.clientId, runPollLoop]);

  return { state, start, cancel };
}

async function completeAccountConnect(
  accessToken: string,
  onConnected: (account: Account) => void,
): Promise<void> {
  const user = await fetchAuthenticatedUser({ token: accessToken });
  const apiInstallations = await fetchUserInstallations({ token: accessToken });
  const installations: Installation[] = await Promise.all(
    apiInstallations.map(async (installation) => {
      const repoFullNames =
        installation.repositorySelection === "selected"
          ? await fetchInstallationRepositories({
              token: accessToken,
              installationId: installation.id,
            })
          : null;
      return {
        id: installation.id,
        account: installation.account,
        repositorySelection: installation.repositorySelection,
        repoFullNames,
      };
    }),
  );
  const account: Account = {
    id: globalThis.crypto.randomUUID(),
    login: user.login,
    avatarUrl: user.avatarUrl,
    token: accessToken,
    createdAt: Date.now(),
    installations,
    installationsRefreshedAt: Date.now(),
    invalidated: false,
    invalidatedReason: null,
  };
  await addAccount(account);
  await replaceInstallations(account.id, installations);
  onConnected(account);
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test -- tests/device-flow-controller.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/options/device-flow-controller.ts tests/device-flow-controller.test.ts package.json pnpm-lock.yaml
git commit -m "feat(options): add device flow controller hook with polling state machine"
```

---

## Task 13: AddAccountPanel component

Render the inline device flow panel from spec §5.1. The component consumes `useDeviceFlowController`.

**Files:**
- Create: `entrypoints/options/components/AddAccountPanel.tsx`

- [ ] **Step 1: Implement the component**

Create `entrypoints/options/components/AddAccountPanel.tsx`:

```tsx
import { type CSSProperties } from "react";

import { getGitHubAppConfig } from "../../../src/config/github-app";
import type { Account } from "../../../src/storage/accounts";

import { useDeviceFlowController } from "../device-flow-controller";

type Props = {
  onConnected: (account: Account) => void;
};

export function AddAccountPanel({ onConnected }: Props) {
  const appConfig = getGitHubAppConfig();
  const controller = useDeviceFlowController({
    clientId: appConfig.clientId,
    onConnected,
  });
  const { state } = controller;

  if (state.phase === "idle") {
    return (
      <div style={styles.panel}>
        <button
          type="button"
          data-testid="add-account-start"
          onClick={controller.start}
          style={styles.primaryButton}
        >
          Add account
        </button>
      </div>
    );
  }

  if (state.phase === "initiating") {
    return <div style={styles.panel}>Requesting device code...</div>;
  }

  if (state.phase === "waiting") {
    return (
      <div style={styles.panel}>
        <p style={styles.title}>Enter this code on GitHub to authorize:</p>
        <div style={styles.codeRow}>
          <code style={styles.code} data-testid="device-user-code">
            {state.userCode}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(state.userCode);
            }}
            style={styles.secondaryButton}
          >
            Copy
          </button>
        </div>
        <a
          href={state.verificationUriComplete}
          target="_blank"
          rel="noreferrer"
          style={styles.primaryLink}
        >
          Open GitHub to authorize →
        </a>
        <p style={styles.hint}>Waiting for authorization…</p>
        <p style={styles.hint}>
          Code expires at {new Date(state.expiresAt).toLocaleTimeString()}.
        </p>
        <button type="button" onClick={controller.cancel} style={styles.secondaryButton}>
          Cancel
        </button>
      </div>
    );
  }

  if (state.phase === "fetching_installations") {
    return <div style={styles.panel}>Loading your installations…</div>;
  }

  if (state.phase === "connected") {
    return (
      <div style={styles.panel}>
        Account connected. You can add another account or close this panel.
      </div>
    );
  }

  if (state.phase === "expired") {
    return (
      <div style={styles.panel}>
        <p>The device code expired.</p>
        <button type="button" onClick={controller.start} style={styles.primaryButton}>
          Generate a new code
        </button>
      </div>
    );
  }

  if (state.phase === "denied") {
    return (
      <div style={styles.panel}>
        <p>Authorization was denied.</p>
        <button type="button" onClick={controller.start} style={styles.primaryButton}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      <p>
        Could not complete sign-in: {state.message} ({state.code}).
      </p>
      <button type="button" onClick={controller.cancel} style={styles.secondaryButton}>
        Close
      </button>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    padding: 16,
    borderRadius: 16,
    background: "#fffdf9",
    border: "1px solid rgba(34, 29, 24, 0.08)",
    display: "grid",
    gap: 12,
  },
  title: { margin: 0, fontWeight: 600 },
  codeRow: { display: "flex", gap: 12, alignItems: "center" },
  code: {
    padding: "8px 12px",
    background: "#f6f8fa",
    borderRadius: 8,
    fontSize: 18,
    letterSpacing: "0.1em",
  },
  primaryLink: {
    color: "#1f6feb",
    fontWeight: 600,
    textDecoration: "none",
  },
  hint: { margin: 0, color: "#52463b", fontSize: 13 },
  primaryButton: {
    border: 0,
    borderRadius: 999,
    padding: "12px 18px",
    background: "#1f6feb",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
  },
  secondaryButton: {
    borderRadius: 999,
    padding: "12px 18px",
    background: "#fffdf9",
    border: "1px solid #d3c4ae",
    color: "#3b3024",
    fontWeight: 700,
    cursor: "pointer",
  },
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add entrypoints/options/components/AddAccountPanel.tsx
git commit -m "feat(options): add AddAccountPanel component with device flow UI"
```

---

## Task 14: AccountsList component

Render each connected account with its installation summary and Refresh / Remove / Sign in again actions.

**Files:**
- Create: `entrypoints/options/components/AccountsList.tsx`

- [ ] **Step 1: Implement the component**

Create `entrypoints/options/components/AccountsList.tsx`:

```tsx
import { type CSSProperties } from "react";

import {
  fetchInstallationRepositories,
  fetchUserInstallations,
} from "../../../src/github/auth";
import {
  removeAccount,
  replaceInstallations,
  type Account,
  type Installation,
} from "../../../src/storage/accounts";

type Props = {
  accounts: Account[];
  onChange: () => Promise<void>;
  onReauthenticate: (account: Account) => void;
};

export function AccountsList({ accounts, onChange, onReauthenticate }: Props) {
  async function handleRefresh(account: Account) {
    const apiInstallations = await fetchUserInstallations({
      token: account.token,
    });
    const installations: Installation[] = await Promise.all(
      apiInstallations.map(async (installation) => ({
        id: installation.id,
        account: installation.account,
        repositorySelection: installation.repositorySelection,
        repoFullNames:
          installation.repositorySelection === "selected"
            ? await fetchInstallationRepositories({
                token: account.token,
                installationId: installation.id,
              })
            : null,
      })),
    );
    await replaceInstallations(account.id, installations);
    await onChange();
  }

  async function handleRemove(account: Account) {
    await removeAccount(account.id);
    await onChange();
  }

  if (accounts.length === 0) {
    return (
      <p style={styles.hint} data-testid="accounts-empty">
        No GitHub accounts connected yet.
      </p>
    );
  }

  return (
    <div style={styles.list}>
      {accounts.map((account) => (
        <div
          key={account.id}
          style={{
            ...styles.card,
            opacity: account.invalidated ? 0.6 : 1,
          }}
          data-testid={`account-card-${account.login}`}
        >
          <p style={styles.login}>@{account.login}</p>
          <p style={styles.meta}>
            Installed on:{" "}
            {account.installations.length === 0
              ? "none yet"
              : account.installations
                  .map((installation) => `@${installation.account.login}`)
                  .join(", ")}
          </p>
          {account.invalidated ? (
            <button
              type="button"
              onClick={() => onReauthenticate(account)}
              style={styles.primaryButton}
            >
              Sign in again
            </button>
          ) : (
            <div style={styles.actions}>
              <button
                type="button"
                onClick={() => void handleRefresh(account)}
                style={styles.secondaryButton}
              >
                Refresh installations
              </button>
              <button
                type="button"
                onClick={() => void handleRemove(account)}
                style={styles.dangerButton}
              >
                Remove
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  list: { display: "grid", gap: 12 },
  card: {
    padding: 16,
    borderRadius: 16,
    background: "#fffdf9",
    border: "1px solid rgba(34, 29, 24, 0.08)",
  },
  login: { margin: 0, fontWeight: 700 },
  meta: { margin: "6px 0 0", fontSize: 13, color: "#52463b" },
  actions: { display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" },
  hint: { color: "#6e5f52", fontSize: 13 },
  primaryButton: {
    border: 0,
    borderRadius: 999,
    padding: "10px 16px",
    background: "#1f6feb",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
    marginTop: 12,
  },
  secondaryButton: {
    borderRadius: 999,
    padding: "10px 16px",
    background: "#fffdf9",
    border: "1px solid #d3c4ae",
    color: "#3b3024",
    fontWeight: 700,
    cursor: "pointer",
  },
  dangerButton: {
    borderRadius: 999,
    padding: "10px 16px",
    background: "#fff4f4",
    border: "1px solid rgba(207, 34, 46, 0.18)",
    color: "#cf222e",
    fontWeight: 700,
    cursor: "pointer",
  },
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add entrypoints/options/components/AccountsList.tsx
git commit -m "feat(options): add AccountsList component with refresh/remove/reauth"
```

---

## Task 15: DiagnosticsPanel component

Reuse `validateGitHubRepositoryAccess` (now account-based, from Task 7) to run matched-account or no-token diagnostics against a repository the user types in. The panel replaces the old "Repository access check" section of the options page.

**Files:**
- Create: `entrypoints/options/components/DiagnosticsPanel.tsx`

- [ ] **Step 1: Implement the component**

Create `entrypoints/options/components/DiagnosticsPanel.tsx`:

```tsx
import { useState, type CSSProperties } from "react";

import { validateGitHubRepositoryAccess } from "../../../src/github/api";
import {
  resolveAccountForRepo,
  type Account,
} from "../../../src/storage/accounts";

type Status =
  | { tone: "neutral" | "success" | "error"; message: string }
  | null;

export function DiagnosticsPanel() {
  const [repository, setRepository] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [matchedAccount, setMatchedAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);

  async function runMatched() {
    const trimmed = repository.trim();
    const match = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (!match) {
      setStatus({
        tone: "error",
        message: "Enter a repository as owner/name before running diagnostics.",
      });
      return;
    }
    setBusy(true);
    try {
      const account = await resolveAccountForRepo(match[1], match[2]);
      setMatchedAccount(account);
      if (account == null) {
        setStatus({
          tone: "error",
          message: `No connected account covers ${trimmed}. Install the GitHub App on the owner.`,
        });
        return;
      }
      const result = await validateGitHubRepositoryAccess(account, trimmed);
      setStatus({ tone: result.ok ? "success" : "error", message: result.message });
    } finally {
      setBusy(false);
    }
  }

  async function runNoToken() {
    const trimmed = repository.trim();
    if (!trimmed) {
      setStatus({
        tone: "error",
        message: "Enter a repository before running the no-token check.",
      });
      return;
    }
    setBusy(true);
    setMatchedAccount(null);
    try {
      const result = await validateGitHubRepositoryAccess(null, trimmed);
      setStatus({ tone: result.ok ? "success" : "error", message: result.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={styles.section}>
      <h2 style={styles.heading}>Diagnostics</h2>
      <input
        type="text"
        value={repository}
        placeholder="owner/name"
        onChange={(event) => setRepository(event.currentTarget.value)}
        style={styles.input}
        data-testid="diagnostics-repo"
      />
      <div style={styles.actions}>
        <button
          type="button"
          onClick={() => void runMatched()}
          disabled={busy}
          style={styles.primaryButton}
          data-testid="diagnostics-matched"
        >
          Check matched account
        </button>
        <button
          type="button"
          onClick={() => void runNoToken()}
          disabled={busy}
          style={styles.secondaryButton}
          data-testid="diagnostics-no-token"
        >
          Check no-token path
        </button>
      </div>
      {matchedAccount ? (
        <p style={styles.hint}>Matched account: @{matchedAccount.login}.</p>
      ) : null}
      {status ? (
        <p style={{ ...styles.hint, color: toneColor(status.tone) }}>
          {status.message}
        </p>
      ) : null}
    </section>
  );
}

function toneColor(tone: "neutral" | "success" | "error"): string {
  if (tone === "success") return "#1a7f37";
  if (tone === "error") return "#cf222e";
  return "#52463b";
}

const styles: Record<string, CSSProperties> = {
  section: { marginTop: 32 },
  heading: { margin: 0, fontSize: 18 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "14px 16px",
    borderRadius: 12,
    border: "1px solid #d3c4ae",
    background: "#fffdf9",
    fontSize: 15,
    marginTop: 12,
  },
  actions: { display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" },
  hint: { fontSize: 13, color: "#52463b", marginTop: 12 },
  primaryButton: {
    border: 0,
    borderRadius: 999,
    padding: "10px 16px",
    background: "#1f6feb",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
  },
  secondaryButton: {
    borderRadius: 999,
    padding: "10px 16px",
    background: "#fffdf9",
    border: "1px solid #d3c4ae",
    color: "#3b3024",
    fontWeight: 700,
    cursor: "pointer",
  },
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add entrypoints/options/components/DiagnosticsPanel.tsx
git commit -m "feat(options): add DiagnosticsPanel using matched account or no-token path"
```

---

## Task 16: Rewrite `options-page.tsx`

Compose `AccountsList`, `AddAccountPanel`, and `DiagnosticsPanel`. Remove all token form / scope UI and copy. Update `tests/options-page.test.ts` to mock the new modules and assert the new composition.

**Files:**
- Modify: `entrypoints/options/options-page.tsx`
- Modify: `tests/options-page.test.ts`

- [ ] **Step 1: Replace `entrypoints/options/options-page.tsx` entirely**

```tsx
import { useCallback, useEffect, useState, type CSSProperties } from "react";

import { getGitHubAppConfig } from "../../src/config/github-app";
import { listAccounts, type Account } from "../../src/storage/accounts";

import { AccountsList } from "./components/AccountsList";
import { AddAccountPanel } from "./components/AddAccountPanel";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";

export function OptionsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const appConfig = getGitHubAppConfig();

  const reload = useCallback(async () => {
    setAccounts(await listAccounts());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <p style={styles.eyebrow}>GitHub Pulls Show Reviewers</p>
        <h1 style={styles.title}>Reviewer visibility for GitHub pull request lists</h1>
        <p style={styles.body}>
          Sign in with GitHub (via our GitHub App) to see reviewer chips on
          private-repository pull request lists. Public repositories continue to
          work without signing in.
        </p>

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>GitHub accounts</h2>
          <AccountsList
            accounts={accounts}
            onChange={reload}
            onReauthenticate={() => setShowAddPanel(true)}
          />
          {showAddPanel ? (
            <AddAccountPanel
              onConnected={async () => {
                setShowAddPanel(false);
                await reload();
              }}
            />
          ) : (
            <button
              type="button"
              style={styles.primaryButton}
              onClick={() => setShowAddPanel(true)}
              data-testid="accounts-add"
            >
              + Add another account
            </button>
          )}
        </section>

        <DiagnosticsPanel />

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>About</h2>
          <p style={styles.hint}>
            This extension signs you in through the{" "}
            <strong>{appConfig.name}</strong> GitHub App. The App requests{" "}
            <code>Pull requests: Read</code> only. Removing an account locally
            does not revoke the authorization on GitHub — manage revocation at{" "}
            <a
              href="https://github.com/settings/applications"
              target="_blank"
              rel="noreferrer"
            >
              github.com/settings/applications
            </a>
            .
          </p>
        </section>
      </section>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    margin: 0,
    padding: "40px 24px",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    background:
      "radial-gradient(circle at top left, rgba(255, 214, 102, 0.45), transparent 32%), #f4efe6",
    color: "#221d18",
  },
  card: {
    maxWidth: 720,
    margin: "0 auto",
    padding: 32,
    borderRadius: 20,
    background: "rgba(255, 255, 255, 0.82)",
    boxShadow: "0 18px 60px rgba(34, 29, 24, 0.12)",
    border: "1px solid rgba(34, 29, 24, 0.08)",
  },
  section: {
    marginTop: 32,
    paddingTop: 24,
    borderTop: "1px solid rgba(34, 29, 24, 0.08)",
  },
  sectionTitle: { margin: 0, fontSize: 20 },
  eyebrow: {
    margin: 0,
    textTransform: "uppercase",
    letterSpacing: "0.12em",
    fontSize: 12,
    color: "#9f5a14",
    fontWeight: 700,
  },
  title: { margin: "12px 0 16px", fontSize: 36, lineHeight: 1.1 },
  body: { margin: 0, maxWidth: 560, color: "#52463b", lineHeight: 1.6 },
  hint: { color: "#6e5f52", fontSize: 13, lineHeight: 1.6 },
  primaryButton: {
    marginTop: 12,
    border: 0,
    borderRadius: 999,
    padding: "12px 18px",
    background: "#1f6feb",
    color: "white",
    fontWeight: 700,
    cursor: "pointer",
  },
};
```

- [ ] **Step 2: Rewrite `tests/options-page.test.ts`**

Replace the file entirely with:

```ts
// @vitest-environment jsdom
import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Account } from "../src/storage/accounts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const listAccountsMock = vi.fn<() => Promise<Account[]>>(async () => []);

vi.mock("../src/storage/accounts", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/accounts")>();
  return {
    ...actual,
    listAccounts: listAccountsMock,
    addAccount: vi.fn(async () => {}),
    removeAccount: vi.fn(async () => {}),
    replaceInstallations: vi.fn(async () => {}),
    resolveAccountForRepo: vi.fn(async () => null),
  };
});

vi.mock("../src/github/auth", () => ({
  initiateDeviceFlow: vi.fn(),
  pollForAccessToken: vi.fn(),
  fetchAuthenticatedUser: vi.fn(),
  fetchUserInstallations: vi.fn(),
  fetchInstallationRepositories: vi.fn(),
  DeviceFlowError: class extends Error {},
}));

async function renderOptionsPage() {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  const [{ createRoot }, { OptionsPage }] = await Promise.all([
    import("react-dom/client"),
    import("../entrypoints/options/options-page"),
  ]);
  await act(async () => {
    createRoot(document.getElementById("root")!).render(
      createElement(OptionsPage),
    );
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  listAccountsMock.mockReset();
  listAccountsMock.mockResolvedValue([]);
});

describe("OptionsPage", () => {
  it("shows the empty accounts state when no accounts are stored", async () => {
    await renderOptionsPage();
    expect(
      document.querySelector('[data-testid="accounts-empty"]'),
    ).not.toBeNull();
  });

  it("shows the add-account start button", async () => {
    await renderOptionsPage();
    expect(
      document.querySelector('[data-testid="accounts-add"]'),
    ).not.toBeNull();
  });

  it("renders the diagnostics input and buttons", async () => {
    await renderOptionsPage();
    expect(
      document.querySelector('[data-testid="diagnostics-repo"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="diagnostics-matched"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="diagnostics-no-token"]'),
    ).not.toBeNull();
  });

  it("renders account cards when accounts are present", async () => {
    listAccountsMock.mockResolvedValue([
      {
        id: "acc",
        login: "hon454",
        avatarUrl: null,
        token: "ghu_abc",
        createdAt: 1,
        installations: [],
        installationsRefreshedAt: 1,
        invalidated: false,
        invalidatedReason: null,
      },
    ]);
    await renderOptionsPage();
    expect(
      document.querySelector('[data-testid="account-card-hon454"]'),
    ).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the suite**

Run: `pnpm test`
Expected: PASS across the board.

- [ ] **Step 4: Commit**

```bash
git add entrypoints/options/options-page.tsx tests/options-page.test.ts
git commit -m "feat(options): compose accounts, add-account, and diagnostics panels"
```

---

## Task 17: Delete PAT code and tests

With every caller migrated, remove the PAT-era files.

**Files:**
- Delete: `src/storage/settings.ts`
- Delete: `src/storage/token-scopes.ts`
- Delete: `tests/settings.test.ts`
- Delete: `tests/token-scopes.test.ts`

- [ ] **Step 1: Verify there are no remaining imports**

Run: `grep -rnE "storage/(settings|token-scopes)|TokenEntry|maskToken|findDuplicateTokenScope|resolveTokenEntryForRepository|validateGitHubToken\b|buildClassicPatUrl|fineGrainedPat|buildFineGrainedPat" src entrypoints tests`
Expected: no matches (the only hits should be in comments or docs if any — investigate those before continuing).

- [ ] **Step 2: Delete the files**

```bash
git rm src/storage/settings.ts src/storage/token-scopes.ts tests/settings.test.ts tests/token-scopes.test.ts
```

- [ ] **Step 3: Run the full suite**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove classic PAT storage and tests"
```

---

## Task 18: ADR 0003 and ADR 0002 status update

Record the decision and supersede ADR 0002 so future readers know PATs are out.

**Files:**
- Create: `docs/adr/0003-github-app-device-flow.md`
- Modify: `docs/adr/0002-classic-pat-interim-auth.md`

- [ ] **Step 1: Create `docs/adr/0003-github-app-device-flow.md`**

```markdown
# ADR 0003: GitHub App + Device Flow

- Status: Accepted
- Date: 2026-04-21

## Context

[ADR 0002](./0002-classic-pat-interim-auth.md) shipped Classic PAT support as an
interim unblock for users in organizations that disallow fine-grained PATs. It
explicitly called the long-term direction a GitHub App plus device flow.

The long-term direction is now ready. Classic PAT support leaves the extension
holding a token with broader scope than it needs, makes per-organization SSO
authorization the user's problem, and offers no authoritative way to tell
whether a token actually covers a given repository.

## Decision

Ship a maintainer-owned GitHub App plus OAuth Device Flow.

- Store multiple accounts in `browser.storage.local` under a single versioned
  `settings` key. Each account caches its installations (`all` or `selected`
  with explicit full names).
- Run device code polling on the options page because MV3 service workers
  unload on idle.
- Resolve repository access via `resolveAccountForRepo(owner, repo)` using
  the cached installations — no user-typed scope patterns.
- Remove all PAT-era code, storage, copy, and tests.
- Preserve the no-token public-repository path from [ADR 0001](./0001-keep-no-token-support-for-public-repositories.md).

## Rationale

- Scope shrinks from Classic PAT `repo` to GitHub App `Pull requests: Read`.
- Per-organization SSO authorization disappears as a user step; installation
  acceptance is the single gate.
- Installation data gives authoritative coverage rather than relying on user
  scope patterns.
- The flow never needs a client secret: GitHub's device-flow grant-type
  exchange does not require one, and the extension stays purely client-side.
- Multi-account storage matches how GitHub itself models access and avoids a
  second migration when users need both a personal and a work account.

## Consequences

### Positive

- Narrower scope, smaller blast radius.
- No per-token SSO authorization dance.
- Installation-based matching is authoritative and easy to refresh.
- Fewer moving pieces on the rendering side: row-level failure text goes away;
  a single banner handles install guidance.

### Negative

- Some organizations require admin approval for GitHub App installation. Users
  blocked by strict policies rely on the no-token public path.
- User-to-server tokens have no refresh in a pure-client setting (the refresh
  endpoint requires a client secret). Users sign in again when a token is
  revoked — detected lazily and surfaced through the banner and options page.

### Neutral

- No backend proxy. The extension remains client-side.
- PAT-era saved tokens are not migrated; the v2 settings shape overwrites
  legacy `tokenEntries` payloads with an empty account list.

## Links

- [ADR 0001](./0001-keep-no-token-support-for-public-repositories.md) — no-token
  public path, preserved.
- [ADR 0002](./0002-classic-pat-interim-auth.md) — superseded by this ADR.
```

- [ ] **Step 2: Flip ADR 0002 status line**

Open `docs/adr/0002-classic-pat-interim-auth.md`. Replace:

```markdown
- Status: Accepted
```

with:

```markdown
- Status: Superseded by [ADR 0003](./0003-github-app-device-flow.md) (2026-04-21)
```

Leave the rest of the body untouched.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0003-github-app-device-flow.md docs/adr/0002-classic-pat-interim-auth.md
git commit -m "docs(adr): accept ADR 0003 and supersede ADR 0002"
```

---

## Task 19: README, AGENTS.md, implementation-notes, privacy policy

Bring user-facing docs in line with the App story and remove PAT copy.

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/implementation-notes.md`
- Modify: `docs/privacy-policy.md`

- [ ] **Step 1: Rewrite the "Authentication Model" section in `README.md`**

Open `README.md` and locate the section that describes Classic PAT setup. Replace that section with:

```markdown
## Authentication Model

- **Public repositories** continue to work without signing in. See
  [ADR 0001](docs/adr/0001-keep-no-token-support-for-public-repositories.md).
- **Private repositories** require signing in with GitHub through our GitHub App.
  Click **Add account** on the options page and complete the OAuth Device Flow
  (enter the short code on github.com, approve, come back to the options tab).
  The App only requests `Pull requests: Read`.
- **Multiple accounts** are supported. Add a personal account and a work
  account side-by-side; the content script resolves the right one per repo from
  each account's installations.
- **Revocation** happens on GitHub's
  [Applications page](https://github.com/settings/applications). Removing an
  account from the options page only deletes the locally stored token.

See [ADR 0003](docs/adr/0003-github-app-device-flow.md) for the rationale.
```

Remove any remaining "Classic PAT", "`public_repo`", "`repo` scope", or "Configure SSO" sentences anywhere else in `README.md`.

- [ ] **Step 2: Update `AGENTS.md` "Product Rules"**

Open `AGENTS.md` and replace the existing bullet:

```markdown
- For private repositories, guide the product toward classic PAT usage (`public_repo` for public-only access, `repo` for private access) and remind users to authorize SSO per organization. A GitHub App flow is the intended long-term replacement and is tracked separately.
```

with:

```markdown
- For private repositories, guide users to sign in with GitHub through the maintainer-owned GitHub App (OAuth Device Flow). Multi-account storage is supported and the App requests `Pull requests: Read` only.
```

- [ ] **Step 3: Rewrite `docs/implementation-notes.md`**

Open `docs/implementation-notes.md`. In "Current MVP behavior", replace every
PAT-era bullet (the ones mentioning tokens, scopes, SSO, or the classic PAT
link) with:

```markdown
- Settings store multiple connected GitHub accounts under a single versioned
  `settings` key. Each account carries a user-to-server token plus a cache of
  its GitHub App installations (`all` or `selected` with explicit full names).
- Device flow runs on the options page. Polling stops when the options tab
  closes; restarts are clean.
- Content-script reviewer fetches resolve the covering account per repo via
  the cached installations. No user-typed scope patterns.
- Row-level failures render an empty reviewer slot. A page-level banner surfaces
  uncovered-org guidance and unauthenticated rate-limit hints.
```

Replace the "Runtime flow" numbered list with:

```markdown
1. Parse the current repository route from `window.location.pathname`.
2. Find PR rows with centralized GitHub selectors.
3. Extract the pull request number from the row id or primary pull request link.
4. Resolve the covering account for `owner/repo` via `resolveAccountForRepo`.
5. Fetch reviewer data from GitHub only when the cache is cold. Use the
   matched account's token, or no token if none matches.
6. Render `Requested` and `Reviewed` sections inline in the PR row metadata area.
7. On API errors, emit a signal to the banner aggregator; do not render
   row-level error text.
8. Re-run row processing when GitHub mutates the page or performs SPA navigation.
```

Replace the "Repository diagnostics matrix" table with an App-aware variant:

```markdown
| Mode               | Response pattern                              | Reported UX                                                                 |
| ------------------ | --------------------------------------------- | --------------------------------------------------------------------------- |
| No signed-in account | 200 for pulls list, pull detail, and reviews | Repository works on the public no-token path                                |
| No signed-in account | 403 with rate-limit signal                   | Unauthenticated rate limit exhausted                                        |
| No signed-in account | 404 / 401 / private-like 403                 | Repository behaves like a private or permission-gated resource              |
| Matched account    | 401 on `/rate_limit` or a repository endpoint | Token was revoked — sign in again from the options page                     |
| Matched account    | 403 / 404 without rate-limit signal           | Installation does not cover this repository — install the GitHub App on the owner |
```

Add a new section at the end:

```markdown
## Device flow

- Polling lives on the options page because MV3 service workers unload on idle.
- `POST /login/oauth/access_token` uses the `urn:ietf:params:oauth:grant-type:device_code` grant type. No `client_secret` is required or sent.
- On `slow_down`, the interval bumps by 5 seconds.
- On `expired_token` or the local clock passing `expires_at`, the panel offers a
  retry that requests a fresh device code.

## Registering a personal GitHub App for development

1. Create a new GitHub App on your account. Set Device Flow to **Enabled** and
   Repository permissions to `Pull requests: Read` only.
2. Copy the Client ID and App slug into `.env.local`:

```bash
WXT_GITHUB_APP_CLIENT_ID=<your-client-id>
WXT_GITHUB_APP_SLUG=<your-app-slug>
WXT_GITHUB_APP_NAME=<optional display name>
```

3. Run `pnpm dev` and open the options page to exercise the device flow against
   your personal App.
```

- [ ] **Step 4: Update `docs/privacy-policy.md`**

Open `docs/privacy-policy.md`. Replace the bullet about the optional Classic
PAT with:

```markdown
- User-to-server access tokens issued by GitHub after you sign in with our
  GitHub App (requested permission: `Pull requests: Read`). Tokens are
  long-lived and revocable from
  [github.com/settings/applications](https://github.com/settings/applications).
```

In "Storage and retention", replace the Classic PAT bullet with:

```markdown
- Connected accounts are stored locally in `browser.storage.local` under a
  single `settings` key. Each record contains the GitHub login, avatar URL,
  user-to-server access token, creation timestamp, a cached list of GitHub App
  installations, and a revocation flag. Entries live there until the user
  removes the account.
```

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md docs/implementation-notes.md docs/privacy-policy.md
git commit -m "docs: rewrite README, implementation notes, and privacy policy for GitHub App"
```

---

## Task 20: Chrome Web Store docs

Update the public listing and submission checklist to match the new auth story.

**Files:**
- Modify: `docs/chrome-web-store.md`
- Modify: `docs/chrome-web-store-submission.md`

- [ ] **Step 1: Rewrite the listing copy in `docs/chrome-web-store.md`**

Replace the "Suggested listing copy" section with:

```markdown
## Suggested listing copy

Short description:
`See requested reviewers, teams, and completed review state directly in GitHub pull request lists.`

Detailed description:

`GitHub Pulls Show Reviewers keeps reviewer context visible on GitHub pull request list pages. It adds inline chips for requested reviewers, requested teams, and each reviewer's latest completed review state without turning the page into a general PR dashboard.`

`The extension is designed for a narrow workflow: reviewer visibility first. It caches reviewer lookups per page, keeps GitHub selectors isolated for DOM resilience, and uses a sign-in-with-GitHub flow (via our GitHub App, with Pull requests: Read access only) when private repositories need authentication. The extension only performs read operations.`
```

In the "Manual Chrome Web Store submission checklist", replace the Classic
PAT privacy-form line (`no sale of data... optional classic PAT storage...`) with:

```markdown
7. Confirm the privacy disclosure matches the shipped behavior:
   no sale of data, no advertising, no remote code, GitHub page access only,
   and locally stored GitHub App accounts (one user-to-server token per account
   in `browser.storage.local`) for private-repository access.
```

- [ ] **Step 2: Update `docs/chrome-web-store-submission.md`**

Mirror the same copy changes (short description, detailed description,
privacy-form paragraph). Remove every "Classic PAT", "repo scope",
"public_repo", and "Configure SSO" phrase. Replace the screenshot list so it
names the new assets:

```markdown
- `options-page-overview.png`
- `add-account-device-code.png`
- `accounts-list.png`
- `pr-list-with-banner.png`
```

Leave the actual PNG regeneration to the store-submission pass — the doc edit
is what Task 20 covers.

- [ ] **Step 3: Commit**

```bash
git add docs/chrome-web-store.md docs/chrome-web-store-submission.md
git commit -m "docs(cws): rewrite listing copy and submission checklist for GitHub App"
```

---

## Task 21: Manual testing guide

Delete the PAT scenarios and add the five device-flow scenarios.

**Files:**
- Modify: `docs/manual-chrome-testing.md`

- [ ] **Step 1: Remove the PAT scenarios**

Open `docs/manual-chrome-testing.md`. Delete the entire "Private repository
path" subsection under "4. Verify the main user flows". Also delete every line
from "6. Recommended manual regression checklist" that mentions `classic PAT`,
`repo scope`, `public_repo`, `Configure SSO`, `fine-grained PAT`, or
`cinev-style org`.

- [ ] **Step 2: Add device-flow scenarios**

Under "4. Verify the main user flows", append these subsections:

````markdown
### Signed-in, all-repos installation

1. Open the extension options page.
2. Click **Add account** and complete the device flow with an account where the
   GitHub App is installed on **All repositories**.
3. Visit a private PR list in that account's namespace.
4. Confirm reviewer chips render for every row without an uncovered-org banner.

### Signed-in, selected-repos installation

1. Install the GitHub App on an organization with only two selected
   repositories.
2. Complete the device flow with the owning user.
3. Visit one of the two selected repositories' PR list; confirm reviewer chips
   render.
4. Visit a third repository in that org; confirm an empty reviewer slot per row
   and a banner prompting to add access.

### Uncovered org banner

1. Sign in but do not install the App on `work-org`.
2. Visit a `work-org` PR list.
3. Confirm the top-of-page banner surfaces `work-org` and offers an Install
   link that routes to the App installation page.
4. Click **Dismiss**. Confirm the banner stays dismissed on reload of the same
   URL and reappears on a different PR list path.

### Revoked account

1. On github.com → Settings → Applications, revoke the authorization for the
   test App.
2. Reload a private PR list.
3. Confirm the row reviewer slots become empty and the banner prompts to sign
   in again.
4. Open the options page; confirm the account card shows the invalidated
   styling and a **Sign in again** button.

### Unauthenticated rate limit

1. Sign out of every account in the options page.
2. Refresh a public PR list many times in quick succession to exhaust GitHub's
   unauthenticated rate limit.
3. Confirm row reviewer slots become empty and the banner shows the sign-in CTA
   that opens the options page.
````

- [ ] **Step 3: Commit**

```bash
git add docs/manual-chrome-testing.md
git commit -m "docs(manual-testing): replace PAT scenarios with device flow scenarios"
```

---

## Task 22: Version bump, release notes, and verification gate

Close out the migration: version bump, release notes, full verification.

**Files:**
- Modify: `package.json`
- Create: `docs/releases/v1.2.0.md`

- [ ] **Step 1: Bump the version in `package.json`**

Change `"version": "1.1.0"` to `"version": "1.2.0"`.

- [ ] **Step 2: Create `docs/releases/v1.2.0.md`**

```markdown
## v1.2.0

Ships the long-term authentication story for **GitHub Pulls Show Reviewers**:
GitHub App plus OAuth Device Flow, multi-account storage, and a page-level
uncovered-org banner. Classic PAT support is removed.

### Breaking

- Previously saved PATs are not migrated. Users must click **Add account** on
  the options page and complete the device flow once.

### Highlights

- Sign in with GitHub from the options page via the maintainer-owned GitHub App
  (requested permission: `Pull requests: Read` only).
- Multi-account storage: add a personal account and a work account side-by-side.
  The content script resolves the covering account per repository from cached
  installations.
- New top-of-page banner surfaces uncovered-org guidance and unauthenticated
  rate-limit hints. Row-level error text is gone; failures render an empty
  reviewer slot instead.
- Device flow polling lives on the options page so MV3 service worker restarts
  never strand an in-flight sign-in.

### Security

- Token scope is narrower than the PAT era: `Pull requests: Read` rather than
  Classic PAT `repo`.
- No client secret is embedded; the extension remains purely client-side.

### Out of scope (explicit)

- User token refresh (the refresh endpoint requires a client secret).
- A backend proxy service.
- OAuth Authorization Code flow with redirect.

### Links

- [ADR 0003 — GitHub App + Device Flow](../adr/0003-github-app-device-flow.md)
- [ADR 0002 — Classic PAT Interim Auth (Superseded)](../adr/0002-classic-pat-interim-auth.md)
- [ADR 0001 — Keep No-Token Support For Public Repositories](../adr/0001-keep-no-token-support-for-public-repositories.md)

**Full Changelog**: https://github.com/hon454/github-pulls-show-reviewers/compare/v1.1.0...v1.2.0
```

- [ ] **Step 3: Run the full release gate**

Run: `pnpm verify:release`
Expected: PASS across lint, typecheck, unit, and e2e suites. Playwright
requires a one-time install: if a browser is missing, run
`pnpm exec playwright install chromium` first.

If the e2e suite fails because a fixture loads `browser.storage.local.settings`
with `tokenEntries`, update the fixture setup in `tests/e2e/extension.spec.ts`
to seed an `Account` shape (login, token, empty installations) via
`browser.storage.local.set`. This is the only expected fallout — all other
paths are already migrated.

- [ ] **Step 4: Commit**

```bash
git add package.json docs/releases/v1.2.0.md tests/e2e/extension.spec.ts
git commit -m "chore: release v1.2.0 with GitHub App + device flow"
```

---

## Self-Review Checklist

**Spec coverage.** Each §6 row has a task:

- `src/config/github-app.ts`, `.env.example`, `wxt.config.ts` — Task 1.
- `src/storage/accounts.ts` schemas + CRUD — Task 2.
- `src/storage/accounts.ts` `resolveAccountForRepo` — Task 3.
- `src/github/auth.ts` device flow — Task 4.
- `src/github/auth.ts` `/user` + installations + pagination — Task 5.
- `src/features/reviewers/index.ts` result type `status` — Task 6.
- `src/github/api.ts` App-aware copy + account-based validators — Task 7.
- `src/features/reviewers/*` drop error rendering — Task 8.
- `src/features/access-banner/aggregator.ts` — Task 9.
- `src/features/access-banner/dom.ts` — Task 10.
- `src/features/access-banner/index.ts` + `entrypoints/content.ts` — Task 11.
- `entrypoints/options/device-flow-controller.ts` — Task 12.
- `AddAccountPanel.tsx` — Task 13.
- `AccountsList.tsx` — Task 14.
- `DiagnosticsPanel.tsx` — Task 15.
- `options-page.tsx` composition — Task 16.
- Delete `settings.ts`, `token-scopes.ts`, and their tests — Task 17.
- ADR 0003 + ADR 0002 status — Task 18.
- README, AGENTS, implementation notes, privacy — Task 19.
- Chrome Web Store docs — Task 20.
- Manual testing guide — Task 21.
- `package.json` bump + `docs/releases/v1.2.0.md` + verify — Task 22.

**Placeholder scan.** No TBD, TODO, "fill in details", "similar to Task N", or
ellipses in step bodies. Each step block contains the code, command, or exact
file edit the engineer needs.

**Type consistency.**

- `Account` is defined in Task 2 and consumed in Tasks 3, 8, 11, 12, 14, 15, 16.
- `Installation` defined in Task 2 and consumed in Tasks 12, 14.
- `PullReviewerSummary.status` added in Task 6 before banner aggregator reads
  it in Tasks 8 / 9 / 11.
- `validateGitHubRepositoryAccess(account | null, repository)` renamed in
  Task 7 before it's consumed in Task 15.
- `DeviceFlowInit` fields (`deviceCode`, `userCode`, `verificationUri`,
  `verificationUriComplete`, `expiresIn`, `interval`) line up between
  Task 4 and Task 12.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-21-github-app-device-flow.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
