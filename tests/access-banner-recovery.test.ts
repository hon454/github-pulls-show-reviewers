import type * as AccountsStorageModule from "../src/storage/accounts";
import type * as UIClientModule from "../src/runtime/ui-client";
import type * as RuntimePreferencesModule from "../src/runtime/preferences";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentScriptContext } from "wxt/utils/content-script-context";

import type { ReviewerOutcomeSnapshot } from "../src/features/reviewers/outcomes";
import type { PullReviewerSummary } from "../src/github/api";
import type { Locale } from "../src/i18n";
import type { Account } from "../src/storage/accounts";
import type { Preferences } from "../src/shared/preferences";
import { createUIPresentationFixtures } from "./helpers/ui-presentation-fixtures";
import { createPullListFixtureHtml } from "./helpers/pull-list-fixtures";

const resolveAccount = vi.fn();
vi.mock("../src/runtime/repository-discovery", () => ({
  beginRepositoryDiscovery: async (input: {
    owner: string;
    repo: string;
    generation: number;
  }) => ({ ...input, id: `fixture-discovery-${input.generation}` }),
  retireRepositoryDiscovery: async () => null,
}));
const listAccounts = vi.fn();
vi.mock("../src/storage/accounts", async (importActual) => ({
  ...(await importActual<typeof AccountsStorageModule>()),
  resolveAccountForRepo: resolveAccount,
  listAccounts,
}));

vi.mock("../src/runtime/ui-client", async (importActual) => ({
  ...(await importActual<typeof UIClientModule>()),
  getUIClient: () => uiFixtures.client,
  disposeUIClient: () => uiFixtures.client.dispose(),
}));
vi.mock("../src/runtime/preferences", async (importActual) => ({
  ...(await importActual<typeof RuntimePreferencesModule>()),
  getPreferences: async () => preferences,
}));
vi.mock("../src/runtime/accounts", async () => {
  const { createSelfHealingAccountResolver } =
    await import("../src/background/account-resolution");
  const { summarizeAccount } =
    await import("../src/background/account-summary");
  const resolver = createSelfHealingAccountResolver({
    requestRefresh: async () => false,
  });
  return {
    resolveAccountForRepo: async (owner: string, repo: string) => {
      const result = await resolver.resolveAccount(owner, repo);
      return result ? summarizeAccount(result) : null;
    },
    resolveFallbackAccount: async (owner: string) => {
      const result = await resolver.resolveFallbackAccount(owner);
      return result ? summarizeAccount(result) : null;
    },
  };
});

type Message = { type: string; pullNumber?: string; accountId?: string };
let uiFixtures: ReturnType<typeof createUIPresentationFixtures>;
let teardown: Array<() => void>;
let snapshots: ReviewerOutcomeSnapshot[];
let preferences: Preferences;
let metadata: (message: Message) => Promise<unknown>;
let summary: (message: Message) => Promise<unknown>;
const sendMessage = vi.fn();
const route = { owner: "cinev", repo: "shotloom" };
const pathname = "/cinev/shotloom/pulls";
const locales: Locale[] = ["en", "ko", "ja", "zh_CN", "zh_TW"];
const account: Account = {
  id: "fixture-account",
  login: "fixture-user",
  token: "fixture-token",
  credentialGeneration: "fixture-generation",
  avatarUrl: null,
  createdAt: 1,
  invalidated: false,
  invalidatedReason: null,
  refreshToken: null,
  expiresAt: null,
  refreshTokenExpiresAt: null,
  installationsRefreshedAt: 1,
  installations: [
    {
      id: 1,
      account: { login: "cinev", type: "Organization", avatarUrl: null },
      repositorySelection: "all",
      repoSnapshot: null,
    },
  ],
};
const alice: PullReviewerSummary = {
  status: "ok",
  requestedUsers: [{ login: "alice", avatarUrl: null }],
  requestedTeams: [],
  completedReviews: [],
};
const empty: PullReviewerSummary = { ...alice, requestedUsers: [] };
const success = (value = alice) => ({ ok: true, summary: value });
const failure = (status: number) => ({
  ok: false,
  error: {
    kind: "github-api",
    status,
    failures: [
      {
        status,
        endpoint: "/repos/cinev/shotloom/pulls",
        rateLimited: status === 429,
      },
    ],
  },
});
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
function installRows(numbers: string[]): void {
  const fixture = new DOMParser().parseFromString(
    createPullListFixtureHtml(numbers, route),
    "text/html",
  );
  document.body.innerHTML = `<div class="pr-toolbar"></div>${fixture.body.innerHTML}`;
}
function banner(): Element | null {
  return document.querySelector("[data-ghpsr-banner]");
}
function latest() {
  return snapshots.at(-1)!;
}
function messages(type: string): Message[] {
  return sendMessage.mock.calls
    .map(([message]) => message as Message)
    .filter((message) => message.type === type);
}
function storage(changes: object): void {
  uiFixtures.publishFixtureChange(
    changes as Record<string, { oldValue?: unknown; newValue?: unknown }>,
    "local",
  );
}
function connect(): void {
  resolveAccount.mockResolvedValue(account);
  listAccounts.mockResolvedValue([account]);
  storage({
    settings: {
      oldValue: { version: 4, accountIds: [] },
      newValue: { version: 4, accountIds: [account.id] },
    },
  });
}
function changePreferences(patch: Partial<Preferences>): void {
  const previous = preferences;
  preferences = { ...preferences, ...patch };
  storage({ preferences: { oldValue: previous, newValue: preferences } });
}
function mutate(number: string): void {
  document
    .querySelector(`#issue_${number} .issue-meta-section`)!
    .append(" edited");
}
function replaceMetadata(number: string): void {
  const native = document.querySelector(
    `#issue_${number} .d-flex.mt-1.text-small.color-fg-muted`,
  )!;
  const replacement = native.cloneNode(true) as Element;
  replacement
    .querySelectorAll("[data-ghpsr-root], [data-ghpsr-reviewer-meta]")
    .forEach((node) => node.remove());
  native.replaceWith(replacement);
}
function refresh(path = pathname): void {
  window.history.replaceState({}, "", path);
  window.dispatchEvent(new Event("wxt:locationchange"));
}
async function boot(): Promise<void> {
  // Observe the real coordinator's publications without replacing any feature
  // boot, controller, scheduler, banner or locale lifecycle. The account and
  // snapshot fixtures here exercise presentation; real bridge tests cover isolation.
  const module = await import("../src/features/reviewers/outcomes");
  const create = module.createReviewerOutcomeCoordinator;
  vi.spyOn(module, "createReviewerOutcomeCoordinator").mockImplementation(
    (onChange) =>
      create((snapshot) => {
        snapshots.push(snapshot);
        onChange(snapshot);
      }),
  );
  const ctx = {
    addEventListener(
      target: EventTarget,
      event: string,
      listener: EventListener,
    ) {
      target.addEventListener(event, listener);
      teardown.push(() => target.removeEventListener(event, listener));
    },
    setInterval: vi.fn(),
    onInvalidated: (fn: () => void) => teardown.push(fn),
  } as unknown as ContentScriptContext;
  const { default: content } = await import("../entrypoints/content");
  content.main(ctx);
  await drain();
}

beforeEach(() => {
  vi.resetModules();
  resolveAccount.mockReset().mockResolvedValue(null);
  listAccounts.mockReset().mockResolvedValue([]);
  sendMessage.mockReset().mockImplementation((message: Message) => {
    if (message.type === "fetchPullReviewerMetadataBatch")
      return metadata(message);
    if (message.type === "fetchPullReviewerSummary") return summary(message);
    return Promise.resolve({ ok: true });
  });
  metadata = async () => ({ ok: true, metadata: [] });
  summary = async () => success();
  uiFixtures = createUIPresentationFixtures(async () => preferences);
  teardown = [];
  snapshots = [];
  preferences = {
    version: 1,
    language: "en",
    showStateBadge: true,
    showReviewerName: false,
    openPullsOnly: true,
  };
  vi.stubGlobal("defineContentScript", <T>(config: T) => config);
  vi.stubGlobal("__GITHUB_APP_CLIENT_ID__", "Iv1.testclient");
  vi.stubGlobal("__GITHUB_APP_SLUG__", "test-app");
  vi.stubGlobal("__GITHUB_APP_NAME__", "Fixture App");
  vi.stubGlobal("__PROD__", true);
  vi.stubGlobal("browser", {
    i18n: { getUILanguage: () => "en" },
    runtime: {
      getURL: (path: string) => `chrome-extension://fixture${path}`,
      sendMessage,
    },
    storage: {
      onChanged: {
        addListener: vi.fn(() => {
          throw new Error("UI cannot subscribe to auth storage");
        }),
      },
    },
  });
  document.head.innerHTML = "";
  window.sessionStorage.clear();
  window.history.replaceState({}, "", pathname);
  installRows(["42", "43"]);
});
afterEach(async () => {
  teardown.forEach((fn) => fn());
  await drain();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("real content access banner recovery", () => {
  it.each(["reviewers", "empty"])(
    "preserves a fresh %s outcome and another row's failure through mount-only repair",
    async (value) => {
      summary = async ({ pullNumber }) =>
        pullNumber === "42"
          ? success(value === "empty" ? empty : alice)
          : failure(500);
      await boot();
      const published = latest();
      const count = sendMessage.mock.calls.length;
      const cache = await import("../src/cache/reviewer-cache");
      const key = cache.buildReviewerCacheKey("cinev", "shotloom", "42");
      const entry = cache.getReviewerCacheEntry(key);
      for (let replacement = 0; replacement < 3; replacement += 1) {
        replaceMetadata("42");
        await drain();
        expect(
          document.querySelectorAll("#issue_42 [data-ghpsr-root]"),
        ).toHaveLength(1);
        expect(document.querySelector("#issue_42 .ghpsr-status")).toBeNull();
        expect(
          document.querySelectorAll("#issue_42 a.ghpsr-avatar"),
        ).toHaveLength(value === "empty" ? 0 : 1);
        expect(latest()).toBe(published);
        expect(sendMessage).toHaveBeenCalledTimes(count);
        expect(cache.getReviewerCacheEntry(key)).toBe(entry);
        expect(banner()?.textContent).toContain(
          "Reviewer data is temporarily unavailable",
        );
      }
    },
  );

  it.each(["success", "failure"])(
    "keeps stale chips separate from a mount repair's real revalidation %s",
    async (result) => {
      summary = async ({ pullNumber }) =>
        pullNumber === "42" ? success() : failure(500);
      await boot();
      const pending = deferred();
      summary = () => pending.promise;
      const cache = await import("../src/cache/reviewer-cache");
      cache.markReviewerCacheStale(
        cache.buildReviewerCacheKey("cinev", "shotloom", "42"),
      );
      const retained = latest().rows.find(
        ({ pullNumber }) => pullNumber === "43",
      );
      replaceMetadata("42");
      await drain();
      expect(latest().generation).toBe(0);
      expect(
        latest().rows.find(({ pullNumber }) => pullNumber === "42")?.outcome
          .status,
      ).toBe("pending");
      expect(document.querySelector("#issue_42 a.ghpsr-avatar")).not.toBeNull();
      expect(banner()).not.toBeNull();
      pending.resolve(result === "success" ? success() : failure(429));
      await drain();
      expect(latest().rows.find(({ pullNumber }) => pullNumber === "43")).toBe(
        retained,
      );
      expect(
        latest().rows.find(({ pullNumber }) => pullNumber === "42")?.outcome
          .status,
      ).toBe(result);
      expect(banner()?.textContent).toContain(
        result === "success"
          ? "Reviewer data is temporarily unavailable"
          : "unauthenticated request limit",
      );
      expect(document.querySelector("#issue_42 a.ghpsr-avatar")).not.toBeNull();
      expect(
        messages("fetchPullReviewerSummary").map(
          ({ pullNumber }) => pullNumber,
        ),
      ).toEqual(["42", "43", "42"]);
    },
  );

  it.each(["auth", "installations"])(
    "recovers after an existing account's %s storage event",
    async (kind) => {
      resolveAccount.mockResolvedValue(account);
      metadata = async () => failure(kind === "auth" ? 401 : 404);
      await boot();
      expect(banner()).not.toBeNull();
      metadata = async () => ({ ok: true, metadata: [] });
      storage({
        [`account:${kind}:${account.id}`]: {
          oldValue:
            kind === "auth"
              ? { token: "old-fixture" }
              : { installations: [], installationsRefreshedAt: 0 },
          newValue:
            kind === "auth"
              ? { token: "new-fixture" }
              : {
                  installations: account.installations,
                  installationsRefreshedAt: 1,
                },
        },
      });
      await drain();
      expect(latest().generation).toBe(1);
      expect(
        latest().rows.every(({ outcome }) => outcome.status === "success"),
      ).toBe(true);
      expect(banner()).toBeNull();
      expect(document.querySelectorAll("a.ghpsr-avatar")).toHaveLength(2);
    },
  );

  it("reports successful fallback-account retries as success without retaining the initial signed-out failure", async () => {
    listAccounts.mockResolvedValue([account]);
    summary = async () => ({
      ...success(),
      account: {
        id: account.id,
        login: account.login,
        avatarUrl: null,
        revision: "fixture-generation",
        invalidated: false,
        invalidatedReason: null,
        installations: [],
        installationsRefreshedAt: 1,
      },
    });
    await boot();
    expect(
      latest().rows.every(({ outcome }) => outcome.status === "success"),
    ).toBe(true);
    expect(banner()).toBeNull();
    expect(
      messages("fetchPullReviewerSummary").map(({ accountId }) => accountId),
    ).toEqual([null, null]);
    expect(document.querySelectorAll("a.ghpsr-avatar")).toHaveLength(2);
  });

  it.each(["account", "route"])(
    "cancels four active requests and the queued fifth across a %s change without publishing old outcomes",
    async (change) => {
      installRows(["1", "2", "3", "4", "5"]);
      const old = deferred();
      summary = () => old.promise;
      await boot();
      expect(messages("fetchPullReviewerSummary")).toHaveLength(4);
      summary = async () => success();
      if (change === "account") connect();
      else refresh("/cinev/other/pulls");
      await drain();
      expect(messages("cancelPullReviewerSummary")).toHaveLength(4);
      expect(
        messages("fetchPullReviewerSummary").map(
          ({ pullNumber }) => pullNumber,
        ),
      ).toEqual(["1", "2", "3", "4", "1", "2", "3", "4", "5"]);
      expect(latest().generation).toBe(1);
      expect(
        latest().rows.every(({ outcome }) => outcome.status === "success"),
      ).toBe(true);
      const published = latest();
      old.resolve(failure(401));
      await drain();
      expect(latest()).toBe(published);
      expect(banner()).toBeNull();
    },
  );

  it("remounts existing guidance across a same-path toolbar replacement while the new generation is pending", async () => {
    summary = async () => failure(500);
    await boot();
    const pending = deferred();
    summary = () => pending.promise;
    const target = document.querySelector(".pr-toolbar")!;
    const replacement = target.cloneNode() as Element;
    target.replaceWith(replacement);
    banner()!.remove();
    document.dispatchEvent(new Event("turbo:render"));
    await drain();
    expect(latest().generation).toBe(1);
    expect(
      latest().rows.every(({ outcome }) => outcome.status === "pending"),
    ).toBe(true);
    expect(banner()?.textContent).toContain(
      "Reviewer data is temporarily unavailable",
    );
    expect(banner()?.previousElementSibling).toBe(replacement);
    // Removing just the banner element also preserves aggregate state.
    banner()!.remove();
    changePreferences({ language: "ko" });
    await drain();
    expect(banner()?.getAttribute("lang")).toBe("ko");
    pending.resolve(success());
    await drain();
    expect(banner()).toBeNull();
  });

  it("clears signed-out 404 guidance after an account event and every visible success, including an empty summary", async () => {
    metadata = async () => failure(404);
    await boot();
    expect(banner()?.textContent).toContain("Sign in with GitHub");
    expect(messages("fetchPullReviewerMetadataBatch")).toHaveLength(1);
    expect(messages("fetchPullReviewerSummary")).toHaveLength(0);
    expect(
      latest().rows.every(({ outcome }) => outcome.status === "failure"),
    ).toBe(true);
    // One shared failure identity, with every suppressed row terminal.
    expect(
      new Set(
        latest().rows.map(
          ({ outcome }) => outcome.status === "failure" && outcome.failure,
        ),
      ).size,
    ).toBe(1);

    const pending = new Map(["42", "43"].map((number) => [number, deferred()]));
    metadata = async () => ({ ok: true, metadata: [] });
    summary = (message) => pending.get(message.pullNumber!)!.promise;
    connect();
    await drain();
    expect(latest().generation).toBe(1);
    expect(
      latest().rows.every(({ outcome }) => outcome.status === "pending"),
    ).toBe(true);
    expect(banner()?.textContent).toContain("Sign in with GitHub");
    pending.get("42")!.resolve(success());
    await drain();
    expect(document.querySelector("#issue_42 a.ghpsr-avatar")).not.toBeNull();
    expect(banner()).not.toBeNull();
    pending.get("43")!.resolve(success(empty));
    await drain();
    expect(banner()).toBeNull();
    expect(document.querySelector("#issue_43 .ghpsr-root")?.textContent).toBe(
      "",
    );
    expect(
      latest().rows.every(({ outcome }) => outcome.status === "success"),
    ).toBe(true);
    expect(window.location.pathname).toBe(pathname);
    expect(messages("fetchPullReviewerMetadataBatch")).toHaveLength(2);
    expect(messages("fetchPullReviewerSummary")).toHaveLength(2);
  });

  it.each(["success first", "failure first"])(
    "retains two-row mixed failures with %s",
    async (order) => {
      const first = deferred();
      const second = deferred();
      summary = ({ pullNumber }) =>
        pullNumber === "42" ? first.promise : second.promise;
      await boot();
      if (order === "success first") first.resolve(success());
      else second.resolve(failure(500));
      await drain();
      if (order === "success first") expect(banner()).toBeNull();
      else
        expect(banner()?.textContent).toContain(
          "Reviewer data is temporarily unavailable",
        );
      if (order === "success first") second.resolve(failure(500));
      else first.resolve(success());
      await drain();
      expect(banner()?.textContent).toContain(
        "Reviewer data is temporarily unavailable",
      );
      expect(document.querySelectorAll("a.ghpsr-avatar")).toHaveLength(1);
    },
  );

  it("downgrades an obsolete high-priority failure and keeps another row's failure across a partial retry", async () => {
    resolveAccount.mockResolvedValue(account);
    summary = async ({ pullNumber }) =>
      failure(pullNumber === "42" ? 401 : 500);
    await boot();
    expect(banner()?.textContent).toContain("expired");
    const initialGeneration = latest().generation;
    const retained = latest().rows.find(
      ({ pullNumber }) => pullNumber === "43",
    );
    const retry = deferred();
    summary = () => retry.promise;
    mutate("42");
    await drain();
    expect(latest().generation).toBe(initialGeneration);
    expect(latest().rows.find(({ pullNumber }) => pullNumber === "43")).toBe(
      retained,
    );
    expect(banner()?.textContent).toContain("expired");
    retry.resolve(success());
    await drain();
    expect(banner()?.textContent).toContain(
      "Reviewer data is temporarily unavailable",
    );
    expect(latest().rows.find(({ pullNumber }) => pullNumber === "43")).toBe(
      retained,
    );
    expect(
      messages("fetchPullReviewerSummary").map(({ pullNumber }) => pullNumber),
    ).toEqual(["42", "43", "42"]);
    summary = async () => success();
    mutate("43");
    await drain();
    expect(banner()).toBeNull();
  });

  it("counts the fifth FIFO-queued row and preserves all work through locale/display changes while pending", async () => {
    installRows(["1", "2", "3", "4", "5"]);
    metadata = async () => failure(404);
    await boot();
    const requests = new Map(
      ["1", "2", "3", "4", "5"].map((number) => [number, deferred()]),
    );
    metadata = async () => ({ ok: true, metadata: [] });
    summary = ({ pullNumber }) => requests.get(pullNumber!)!.promise;
    connect();
    await drain();
    expect(
      messages("fetchPullReviewerSummary").map(({ pullNumber }) => pullNumber),
    ).toEqual(["1", "2", "3", "4"]);
    expect(latest().rows).toHaveLength(5);
    expect(
      latest().rows.every(({ outcome }) => outcome.status === "pending"),
    ).toBe(true);
    const publicationCount = snapshots.length;
    const messageCount = sendMessage.mock.calls.length;
    const requestIds = latest().rows.map(({ request }) => request);
    // #173 repairs an active consumer and a still-queued consumer by joining
    // their existing requests. Neither repair invents an outcome or a slot.
    replaceMetadata("1");
    replaceMetadata("5");
    await drain();
    expect(snapshots).toHaveLength(publicationCount);
    expect(sendMessage).toHaveBeenCalledTimes(messageCount);
    expect(latest().rows.map(({ request }) => request)).toEqual(requestIds);
    for (const language of locales) {
      changePreferences({
        language,
        showReviewerName: true,
        showStateBadge: false,
        openPullsOnly: false,
      });
      await drain();
      const { createTranslator, toLanguageTag } = await import("../src/i18n");
      expect(banner()?.textContent).toContain(
        createTranslator(language)("banner_signin_required"),
      );
      expect(banner()?.getAttribute("lang")).toBe(toLanguageTag(language));
      expect(document.querySelector(".ghpsr-status")?.textContent).toBe(
        createTranslator(language)("reviewers_loading"),
      );
      expect(snapshots).toHaveLength(publicationCount);
      expect(sendMessage).toHaveBeenCalledTimes(messageCount);
      expect(latest().rows.map(({ request }) => request)).toEqual(requestIds);
    }
    for (const number of ["1", "2", "3", "4"]) {
      requests.get(number)!.resolve(success());
      await drain();
      expect(banner()).not.toBeNull();
    }
    expect(
      messages("fetchPullReviewerSummary").map(({ pullNumber }) => pullNumber),
    ).toEqual(["1", "2", "3", "4", "5"]);
    expect(
      latest().rows.find(({ pullNumber }) => pullNumber === "5")?.outcome
        .status,
    ).toBe("pending");
    requests.get("5")!.resolve(success());
    await drain();
    expect(banner()).toBeNull();
    expect(document.querySelectorAll("a.ghpsr-pill")).toHaveLength(5);
  });

  it.each(["account", "route"])(
    "ignores delayed old successes and failures after a %s generation change",
    async (change) => {
      const old = [deferred(), deferred()];
      summary = ({ pullNumber }) => old[pullNumber === "42" ? 0 : 1].promise;
      await boot();
      summary = async () => failure(404);
      if (change === "account") connect();
      else refresh("/cinev/other/pulls");
      await drain();
      const published = latest();
      const text = banner()?.textContent;
      expect(text).toBeTruthy();
      old[0].resolve(success());
      old[1].resolve(failure(401));
      await drain();
      expect(latest()).toBe(published);
      expect(banner()?.textContent).toBe(text);
      expect(document.querySelectorAll("a.ghpsr-avatar")).toHaveLength(0);
    },
  );

  it("ignores an old delayed account lookup and old metadata failure after recovery", async () => {
    const lookup = deferred<Account | null>();
    resolveAccount.mockImplementationOnce(() => lookup.promise);
    const oldMetadata = deferred();
    metadata = () => oldMetadata.promise;
    await boot();
    metadata = async () => ({ ok: true, metadata: [] });
    connect();
    await drain();
    expect(banner()).toBeNull();
    expect(document.querySelectorAll("a.ghpsr-avatar")).toHaveLength(2);
    const published = latest();
    const count = sendMessage.mock.calls.length;
    lookup.resolve(null);
    oldMetadata.resolve(failure(404));
    await drain();
    expect(banner()).toBeNull();
    expect(latest()).toBe(published);
    expect(sendMessage).toHaveBeenCalledTimes(count);
  });

  it("treats fresh cache hits as success but keeps stale chips separate from failed revalidation", async () => {
    const cache = await import("../src/cache/reviewer-cache");
    const freshKey = cache.buildReviewerCacheKey("cinev", "shotloom", "42");
    const staleKey = cache.buildReviewerCacheKey("cinev", "shotloom", "43");
    cache.setCachedReviewerSummary(freshKey, empty);
    cache.setCachedReviewerSummary(staleKey, alice);
    cache.markReviewerCacheStale(staleKey);
    summary = async () => failure(500);
    await boot();
    expect(
      latest().rows.find(({ pullNumber }) => pullNumber === "42")?.outcome
        .status,
    ).toBe("success");
    expect(
      latest().rows.find(({ pullNumber }) => pullNumber === "43")?.outcome
        .status,
    ).toBe("failure");
    expect(
      messages("fetchPullReviewerSummary").map(({ pullNumber }) => pullNumber),
    ).toEqual(["43"]);
    expect(document.querySelector("#issue_42 .ghpsr-root")?.textContent).toBe(
      "",
    );
    expect(document.querySelector("#issue_43 a.ghpsr-avatar")).not.toBeNull();
    expect(banner()?.textContent).toContain(
      "Reviewer data is temporarily unavailable",
    );
    expect(
      cache.isReviewerCacheEntryFresh(cache.getReviewerCacheEntry(staleKey)!),
    ).toBe(false);
  });

  it("removes failed outcomes with removed rows, including an empty list", async () => {
    summary = async ({ pullNumber }) =>
      pullNumber === "42" ? failure(500) : success();
    await boot();
    expect(banner()).not.toBeNull();
    document.querySelector("#issue_42")!.remove();
    await drain();
    expect(banner()).toBeNull();
    expect(latest().rows.map(({ pullNumber }) => pullNumber)).toEqual(["43"]);
    document.querySelector("#issue_43")!.remove();
    await drain();
    expect(latest().rows).toEqual([]);
    expect(banner()).toBeNull();
  });

  it("does not publish false recovery when a failed row leaves while another row starts revalidation in the same mutation batch", async () => {
    summary = async ({ pullNumber }) =>
      pullNumber === "42" ? failure(500) : success();
    await boot();
    const pending = deferred();
    summary = () => pending.promise;
    const prior = snapshots.length;
    document.querySelector("#issue_42")!.remove();
    mutate("43");
    await drain();
    expect(banner()).not.toBeNull();
    expect(
      snapshots
        .slice(prior)
        .every(({ rows }) =>
          rows.some(({ outcome }) => outcome.status === "pending"),
        ),
    ).toBe(true);
    pending.resolve(success());
    await drain();
    expect(banner()).toBeNull();
  });

  it("keeps failed, recovered, and dismissed states render-only in every locale", async () => {
    summary = async () => failure(500);
    await boot();
    const { createTranslator } = await import("../src/i18n");
    for (const phase of ["failed", "recovered", "dismissed"] as const) {
      if (phase === "recovered") {
        summary = async () => success();
        mutate("42");
        mutate("43");
        await drain();
      } else if (phase === "dismissed") {
        summary = async () => failure(500);
        mutate("42");
        mutate("43");
        await drain();
        document
          .querySelector<HTMLButtonElement>("[data-ghpsr-banner] button")!
          .click();
      }
      const published = latest();
      const publicationCount = snapshots.length;
      const messageCount = sendMessage.mock.calls.length;
      const cache = await import("../src/cache/reviewer-cache");
      const key = cache.buildReviewerCacheKey("cinev", "shotloom", "42");
      const entry = cache.getReviewerCacheEntry(key);
      const dismissal = window.sessionStorage.getItem(
        `ghpsr:banner-dismissed:${pathname}:reviewers-unavailable`,
      );
      for (const language of locales) {
        changePreferences({
          language,
          showReviewerName: !preferences.showReviewerName,
          openPullsOnly: !preferences.openPullsOnly,
        });
        await drain();
        if (phase === "failed")
          expect(banner()?.textContent).toContain(
            createTranslator(language)("banner_reviewers_unavailable"),
          );
        else expect(banner()).toBeNull();
        expect(latest()).toBe(published);
        expect(snapshots).toHaveLength(publicationCount);
        expect(sendMessage).toHaveBeenCalledTimes(messageCount);
        expect(cache.getReviewerCacheEntry(key)).toBe(entry);
        expect(
          window.sessionStorage.getItem(
            `ghpsr:banner-dismissed:${pathname}:reviewers-unavailable`,
          ),
        ).toBe(dismissal);
      }
    }
    // Recovery does not erase a user's pathname + kind dismissal.
    summary = async () => success();
    mutate("42");
    mutate("43");
    await drain();
    summary = async () => failure(500);
    mutate("42");
    mutate("43");
    await drain();
    expect(banner()).toBeNull();
    expect(
      latest().rows.every(({ outcome }) => outcome.status === "failure"),
    ).toBe(true);
  });
});
