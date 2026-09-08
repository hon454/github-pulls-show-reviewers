// @vitest-environment jsdom
import { waitFor, fireEvent } from "@testing-library/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import {
  clearReviewerCache,
  getReviewerCacheEntry,
  buildReviewerCacheKey,
} from "../src/cache/reviewer-cache";
import { getLocaleStore } from "../src/i18n/browser";
import {
  createTranslator,
  SUPPORTED_LOCALES,
  toLanguageTag,
} from "../src/i18n";
import * as clients from "../src/runtime/ui-client";
import { accountMutations } from "../src/storage/accounts";
import { DiagnosticsPanel } from "../entrypoints/options/components/DiagnosticsPanel";
import { connectInput, json, rotated, deferred } from "./helpers/auth-harness";
import { createPullListFixtureHtml } from "./helpers/pull-list-fixtures";
import {
  createUIBridgeHarness,
  contentSender,
  containsSecret,
  drain,
} from "./helpers/ui-bridge-harness";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => void> = [];
const all = [
  {
    id: 1,
    account: { login: "acme", type: "Organization" as const, avatarUrl: null },
    repositorySelection: "all" as const,
    repoSnapshot: null,
  },
];
const numbers = ["42", "43", "44", "45", "46", "47"];
const pulls = numbers.map((number) => ({
  number: Number(number),
  user: { login: "author" },
  requested_reviewers: [],
  requested_teams: [],
}));
const reviews = [
  {
    id: 1,
    user: { login: "reviewer-b", avatar_url: null },
    state: "APPROVED",
    submitted_at: "2026-09-08T00:00:00Z",
  },
];
const banner = () => document.querySelector("[data-ghpsr-banner]");

async function setup(
  respond: (
    account: string,
    path: string,
    init?: RequestInit,
  ) => Response | Promise<Response>,
  content = true,
) {
  const harness = createUIBridgeHarness();
  await harness.initialize();
  for (const id of ["A", "B"])
    await accountMutations.upsertAccountByLogin(
      connectInput({
        newAccountId: id,
        login: `user-${id}`,
        token: `fixture-access-${id}`,
        refreshToken: `fixture-refresh-${id}`,
        installations: all,
        now: id === "A" ? 1 : 2,
      }),
    );
  await harness.send({ type: "getUISnapshot" });
  const calls: Array<{
    account: string;
    path: string;
    signal: AbortSignal | null | undefined;
  }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const account =
        new Headers(init?.headers)
          .get("Authorization")
          ?.replace("Bearer fixture-access-", "") ?? "anonymous";
      const path = new URL(url).pathname;
      calls.push({ account, path, signal: init?.signal });
      return respond(account, path, init);
    }),
  );
  const sender = contentSender("content-1", "acme/private-b");
  const client = harness.client(content ? sender : undefined);
  vi.spyOn(clients, "getUIClient").mockReturnValue(client);
  harness.browserMock.runtime.sendMessage.mockImplementation((request) =>
    content ? harness.send(request, sender) : harness.send(request),
  );
  let invalid = false;
  const invalidations: Array<() => void> = [];
  const ctx = {
    get isInvalid() {
      return invalid;
    },
    addEventListener(
      target: EventTarget,
      type: string,
      listener: EventListener,
    ) {
      target.addEventListener(type, listener);
      invalidations.push(() => target.removeEventListener(type, listener));
    },
    setInterval: vi.fn(),
    onInvalidated: (callback: () => void) => invalidations.push(callback),
  } as unknown as ContentScriptContext;
  cleanups.push(() => {
    invalid = true;
    invalidations.forEach((callback) => callback());
    client.dispose();
    harness.dispose();
  });
  async function boot() {
    const fixture = new DOMParser().parseFromString(
      createPullListFixtureHtml(numbers, { owner: "acme", repo: "private-b" }),
      "text/html",
    );
    document.body.innerHTML = `<div class="pr-toolbar"></div>${fixture.body.innerHTML}`;
    window.history.replaceState({}, "", "/acme/private-b/pulls");
    vi.stubGlobal("defineContentScript", <T>(config: T) => config);
    const { default: script } = await import("../entrypoints/content");
    script.main(ctx);
  }
  async function patch(patch: Record<string, unknown>) {
    expect(
      await harness.send({ type: "patchPreferences", patch }),
    ).toMatchObject({ ok: true });
    await drain();
  }
  return { harness, calls, client, boot, patch };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  getLocaleStore().dispose();
  await drain();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearReviewerCache();
  document.body.innerHTML = "";
});

it.each([403, 404])(
  "real content/bridge fallback A %s → B renders reviewers, records B, and keeps locale/display changes render-only",
  async (status) => {
    const held = deferred<Response>();
    const entered = deferred<void>();
    const h = await setup((account, path) => {
      if (account === "A" && path.endsWith("/pulls")) {
        entered.resolve();
        return held.promise;
      }
      return json(
        path.endsWith("/pulls")
          ? pulls
          : path.endsWith("/reviews")
            ? reviews
            : [],
      );
    });
    await h.boot();
    await entered.promise;
    const before = h.calls.length;
    const admissions = () =>
      h.harness.browserMock.runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          (message as { type: string }).type === "beginRepositoryDiscovery",
      ).length;
    const generationCount = admissions();
    for (const language of SUPPORTED_LOCALES) await h.patch({ language });
    expect(h.calls).toHaveLength(before);
    expect(admissions()).toBe(generationCount);
    expect(banner()).toBeNull();
    held.resolve(json({}, status));
    await waitFor(() =>
      expect(document.querySelectorAll("a.ghpsr-avatar")).toHaveLength(
        numbers.length,
      ),
    );
    expect(
      h.calls
        .filter((call) => call.path.endsWith("/pulls"))
        .map((call) => call.account),
    ).toEqual(["A", "B"]);
    expect(
      h.calls
        .filter((call) => call.path.endsWith("/reviews"))
        .every((call) => call.account === "B"),
    ).toBe(true);
    for (const number of numbers)
      expect(
        getReviewerCacheEntry(
          buildReviewerCacheKey("acme", "private-b", number),
        )?.account,
      ).toMatchObject({ id: "B" });
    const after = h.calls.length;
    for (const language of SUPPORTED_LOCALES) {
      await h.patch({ language, showReviewerName: true });
      expect(
        document.querySelector<HTMLElement>("[data-ghpsr-root]")?.lang,
      ).toBe(toLanguageTag(language));
      expect(document.querySelector("a.ghpsr-pill")?.textContent).toContain(
        "reviewer-b",
      );
      await h.patch({ showStateBadge: false, openPullsOnly: false });
      expect(document.querySelector(".ghpsr-status")).toBeNull();
    }
    expect(h.calls).toHaveLength(after);
    expect(admissions()).toBe(generationCount);
    expect(banner()).toBeNull();
    const boundary = [
      h.harness.replies,
      [...h.harness.notifications.values()],
      h.harness.session.snapshot(),
    ];
    expect(containsSecret(boundary)).toBe(false);
    expect(JSON.stringify(boundary)).not.toMatch(
      /fixture-access-|fixture-refresh-|repoSnapshot|fullNames/,
    );
  },
);

it.each(["metadata", "reviews"])(
  "terminal %s 401 recovery cannot reopen discovery through its own invalidation notification",
  async (stage) => {
    const h = await setup((account, path) =>
      path === "/login/oauth/access_token"
        ? json({ error: "bad_refresh_token" }, 400)
        : account === "A" && (stage === "metadata" || path.endsWith("/reviews"))
          ? json({}, 401)
          : json(path.endsWith("/pulls") ? pulls : reviews),
    );
    await h.boot();
    await waitFor(async () =>
      expect((await accountMutations.getAccountById("A"))?.invalidated).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(
        h.calls.some((call) => call.account === "B") || banner() !== null,
      ).toBe(true),
    );
    expect(h.calls.some((call) => call.account === "B")).toBe(false);
    expect(document.querySelectorAll("a.ghpsr-avatar")).toHaveLength(0);
    expect(banner()?.textContent).toContain("Sign in again");
  },
);

it("same-account 401 token rotation keeps one discovery identity while A's new 404 can recover through B", async () => {
  const h = await setup((account, path) => {
    if (path === "/login/oauth/access_token") return rotated("A-new");
    if (account === "A") return json({}, 401);
    if (account === "A-new") return json({}, 404);
    return json(path.endsWith("/pulls") ? pulls : reviews);
  });
  await h.boot();
  await waitFor(() =>
    expect(document.querySelectorAll("a.ghpsr-avatar")).toHaveLength(
      numbers.length,
    ),
  );
  expect(
    h.calls
      .filter((call) => call.path.endsWith("/pulls"))
      .map((call) => call.account),
  ).toEqual(["A", "A-new", "B"]);
  expect(
    h.harness.browserMock.runtime.sendMessage.mock.calls.filter(
      ([message]) =>
        (message as { type: string }).type === "beginRepositoryDiscovery",
    ),
  ).toHaveLength(1);
});

it("real options diagnostic UI shows B after fallback and preserves the pending/completed run across five locales", async () => {
  const held = deferred<Response>();
  const entered = deferred<void>();
  const h = await setup((account, path) => {
    if (account === "A") return json({}, 404);
    if (path.endsWith("/pulls")) {
      entered.resolve();
      return held.promise;
    }
    return json(path.endsWith("/reviews") ? reviews : pulls[0]);
  }, false);
  document.body.innerHTML = '<div id="options-root"></div>';
  const root: Root = createRoot(document.querySelector("#options-root")!);
  cleanups.push(() => act(() => root.unmount()));
  await act(async () =>
    root.render(createElement(DiagnosticsPanel, { t: createTranslator("en") })),
  );
  fireEvent.change(document.querySelector("input")!, {
    target: { value: "acme/private-b" },
  });
  await act(async () => {
    fireEvent.click(
      document.querySelector('[data-testid="diagnostics-matched"]')!,
    );
    await entered.promise;
  });
  for (const language of SUPPORTED_LOCALES) {
    await act(async () =>
      root.render(
        createElement(DiagnosticsPanel, { t: createTranslator(language) }),
      ),
    );
    expect(
      document.querySelector('[data-testid="diagnostics-status"]')?.textContent,
    ).toBe(createTranslator(language)("diagnostics_running"));
    expect(h.calls.filter((call) => call.path.endsWith("/pulls"))).toHaveLength(
      2,
    );
  }
  await act(async () => {
    held.resolve(json(pulls));
    await drain();
  });
  await waitFor(() =>
    expect(
      document.querySelector('[data-testid="diagnostics-fields"]')?.textContent,
    ).toContain("user-B"),
  );
  expect(
    h.calls
      .filter((call) => /\/pulls\/42(?:\/reviews)?$/.test(call.path))
      .map((call) => call.path)
      .sort(),
  ).toEqual([
    "/repos/acme/private-b/pulls/42",
    "/repos/acme/private-b/pulls/42/reviews",
  ]);
  expect(
    document.querySelector('[data-testid="diagnostics-status"]')?.textContent,
  ).toContain(
    createTranslator(SUPPORTED_LOCALES.at(-1)!)(
      "diagnostics_accessible_token",
      {
        repository: "acme/private-b",
        pull: "42",
        endpoints:
          "GET /repos/acme/private-b/pulls/42, GET /repos/acme/private-b/pulls/42/reviews",
      },
    ),
  );
  const count = h.calls.length;
  for (const language of SUPPORTED_LOCALES) {
    await act(async () =>
      root.render(
        createElement(DiagnosticsPanel, { t: createTranslator(language) }),
      ),
    );
    expect(
      document.querySelector('[data-testid="diagnostics-fields"]')?.textContent,
    ).toContain("user-B");
    expect((document.querySelector("input") as HTMLInputElement).value).toBe(
      "acme/private-b",
    );
  }
  expect(h.calls).toHaveLength(count);
  expect(containsSecret(h.harness.replies)).toBe(false);
});

it.each(["failure-first", "success-first"])(
  "actual fallback preserves FIFO, queued cancellation, and mixed outcomes (%s)",
  async (order) => {
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    const held = new Map<string, ReturnType<typeof deferred<Response>>>();
    const h = await setup((account, path) => {
      if (account === "A") return json({}, 404);
      if (path.endsWith("/pulls")) return json(pulls);
      if (path.endsWith("/reviews")) {
        const number = path.split("/").at(-2)!;
        started.push(number);
        active += 1;
        peak = Math.max(peak, active);
        const response = deferred<Response>();
        held.set(number, response);
        return response.promise.finally(() => {
          active -= 1;
        });
      }
      return json([]);
    });
    await h.boot();
    await waitFor(() => expect(started).toEqual(["42", "43", "44", "45"]));
    expect(peak).toBe(4);
    expect(banner()).toBeNull();
    document.querySelector("#issue_46")!.remove();
    await drain();
    held.get("42")!.resolve(json(reviews));
    await waitFor(() =>
      expect(started).toEqual(["42", "43", "44", "45", "47"]),
    );
    if (order === "failure-first") held.get("47")!.resolve(json({}, 404));
    for (const number of ["43", "44", "45"])
      held.get(number)!.resolve(json(reviews));
    await waitFor(() =>
      expect(document.querySelectorAll("a.ghpsr-avatar")).toHaveLength(4),
    );
    if (order === "success-first") held.get("47")!.resolve(json({}, 404));
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(document.querySelector("#issue_47 a.ghpsr-avatar")).toBeNull();
    expect(
      h.calls
        .filter((call) => call.path.endsWith("/pulls"))
        .map((call) => call.account),
    ).toEqual(["A", "B"]);
    expect(
      h.calls
        .filter((call) => call.path.endsWith("/reviews"))
        .every((call) => call.account === "B"),
    ).toBe(true);
    expect(peak).toBe(4);
    expect(active).toBe(0);
  },
);

it("actual anonymous row rate limits recover inside the same four FIFO slots without an intermediate banner", async () => {
  let active = 0;
  let peak = 0;
  const held = new Map<string, ReturnType<typeof deferred<Response>>>();
  const started: string[] = [];
  const h = await setup((account, path) => {
    if (path.endsWith("/pulls")) return json(pulls);
    if (path.endsWith("/reviews")) {
      const key = `${account}:${path.split("/").at(-2)}`;
      started.push(key);
      active += 1;
      peak = Math.max(peak, active);
      const response = deferred<Response>();
      held.set(key, response);
      return response.promise.finally(() => {
        active -= 1;
      });
    }
    return json([]);
  });
  await accountMutations.removeAccount("B");
  await accountMutations.replaceInstallations("A", []);
  await h.harness.send({ type: "getUISnapshot" });
  await h.boot();
  await waitFor(() =>
    expect(started).toEqual([
      "anonymous:42",
      "anonymous:43",
      "anonymous:44",
      "anonymous:45",
    ]),
  );
  for (const number of ["42", "43", "44", "45"])
    held.get(`anonymous:${number}`)!.resolve(json({}, 429));
  await waitFor(() =>
    expect(started.filter((key) => key.startsWith("A:"))).toEqual([
      "A:42",
      "A:43",
      "A:44",
      "A:45",
    ]),
  );
  expect(banner()).toBeNull();
  for (const number of numbers) {
    await waitFor(() => expect(held.has(`A:${number}`)).toBe(true));
    held.get(`A:${number}`)!.resolve(json(reviews));
  }
  await waitFor(() =>
    expect(document.querySelectorAll("a.ghpsr-avatar")).toHaveLength(
      numbers.length,
    ),
  );
  expect(started.filter((key) => key.startsWith("A:"))).toEqual(
    numbers.map((number) => `A:${number}`),
  );
  expect(
    h.calls
      .filter((call) => call.path.endsWith("/pulls"))
      .map((call) => call.account),
  ).toEqual(["anonymous", "A"]);
  expect(peak).toBe(4);
  expect(active).toBe(0);
  expect(banner()).toBeNull();
});

it("native row metadata changes revalidate the successful account inside the same discovery budget", async () => {
  let updated = false;
  const h = await setup((account, path) => {
    if (account === "A") return json({}, 404);
    if (path.endsWith("/pulls"))
      return json(
        pulls.map((pull) => ({
          ...pull,
          requested_reviewers: updated ? [{ login: "new-requested" }] : [],
        })),
      );
    return json(reviews);
  });
  await h.boot();
  await waitFor(() =>
    expect(document.querySelectorAll("a.ghpsr-avatar")).toHaveLength(
      numbers.length,
    ),
  );
  updated = true;
  document
    .querySelector("#issue_42 .issue-meta-section")!
    .append(" updated native metadata");
  await waitFor(() =>
    expect(
      document.querySelector(
        '#issue_42 a.ghpsr-avatar[title*="new-requested"]',
      ),
    ).not.toBeNull(),
  );
  expect(
    h.calls
      .filter((call) => call.path.endsWith("/pulls"))
      .map((call) => call.account),
  ).toEqual(["A", "B", "B"]);
  expect(
    h.harness.browserMock.runtime.sendMessage.mock.calls.filter(
      ([message]) =>
        (message as { type: string }).type === "beginRepositoryDiscovery",
    ),
  ).toHaveLength(1);
});

it("exhaustion survives remounts, changed metadata, and five locale/display changes until explicit revalidation", async () => {
  let recovered = false;
  const h = await setup((_account, path) =>
    recovered ? json(path.endsWith("/pulls") ? pulls : reviews) : json({}, 404),
  );
  await h.boot();
  await waitFor(() => expect(banner()).not.toBeNull());
  const attempts = h.calls.length;
  const admissions =
    h.harness.browserMock.runtime.sendMessage.mock.calls.filter(
      ([message]) =>
        (message as { type: string }).type === "beginRepositoryDiscovery",
    ).length;
  recovered = true;
  for (const language of SUPPORTED_LOCALES)
    await h.patch({ language, showReviewerName: true, showStateBadge: false });
  document.querySelector("#issue_42 [data-ghpsr-root]")?.remove();
  document
    .querySelector("#issue_43 .issue-meta-section")!
    .append(" native change");
  await drain();
  expect(h.calls).toHaveLength(attempts);
  expect(
    document.querySelectorAll("a.ghpsr-avatar, a.ghpsr-pill"),
  ).toHaveLength(0);
  expect(
    h.harness.browserMock.runtime.sendMessage.mock.calls.filter(
      ([message]) =>
        (message as { type: string }).type === "beginRepositoryDiscovery",
    ),
  ).toHaveLength(admissions);
  document.dispatchEvent(new Event("turbo:render"));
  await waitFor(() =>
    expect(document.querySelectorAll("a.ghpsr-pill")).toHaveLength(
      numbers.length,
    ),
  );
  expect(
    h.calls
      .filter((call) => call.path.endsWith("/pulls"))
      .map((call) => call.account),
  ).toEqual(["A", "B", "A"]);
  expect(banner()).toBeNull();
});
