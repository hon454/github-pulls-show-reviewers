// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { clearReviewerCache } from "../src/cache/reviewer-cache";
import { bootReviewerListPage } from "../src/features/reviewers/page-controller";
import {
  createTranslator,
  SUPPORTED_LOCALES,
  toLanguageTag,
} from "../src/i18n";
import { getLocaleStore } from "../src/i18n/browser";
import * as clients from "../src/runtime/ui-client";
import type { PreferencePatch } from "../src/shared/preferences";
import { json } from "./helpers/auth-harness";
import { createPullListFixtureHtml } from "./helpers/pull-list-fixtures";
import {
  contentSender,
  createUIBridgeHarness,
  deferred,
  drain,
} from "./helpers/ui-bridge-harness";

const cleanup: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) dispose();
  getLocaleStore().dispose();
  await drain();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearReviewerCache();
  document.body.innerHTML = "";
});

function setup() {
  const harness = createUIBridgeHarness();
  const client = harness.client(contentSender());
  vi.spyOn(clients, "getUIClient").mockReturnValue(client);
  harness.browserMock.runtime.sendMessage.mockImplementation((request) =>
    harness.send(request, contentSender()),
  );
  const fetch = vi.fn(async (url: string) =>
    json(
      new URL(url).pathname.endsWith("/reviews") ||
        new URL(url).pathname.endsWith("/events")
        ? []
        : [
            {
              number: 42,
              user: { login: "author" },
              requested_reviewers: [{ login: "alice" }],
              requested_teams: [],
            },
          ],
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const fixture = new DOMParser().parseFromString(
    createPullListFixtureHtml(["42"], { owner: "octo", repo: "repo" }),
    "text/html",
  );
  document.body.innerHTML = fixture.body.innerHTML;
  window.history.replaceState({}, "", "/octo/repo/pulls");
  const invalidations: Array<() => void> = [];
  const ctx = {
    addEventListener: vi.fn(),
    setInterval: vi.fn(),
    onInvalidated: (callback: () => void) => invalidations.push(callback),
  } as unknown as ContentScriptContext;
  cleanup.push(() => {
    invalidations.forEach((invalidate) => invalidate());
    client.dispose();
    harness.dispose();
  });
  async function patch(patch: PreferencePatch) {
    // Options-origin writes cross the real bridge into the content subscription.
    expect(
      await harness.send({ type: "patchPreferences", patch }),
    ).toMatchObject({
      ok: true,
    });
    await drain();
  }
  return { harness, client, fetch, ctx, patch };
}

it.each([false, true])(
  "renders through the real bridge after initial storage-policy failure=%s",
  async (failInitially) => {
    const { harness, client, fetch, ctx, patch } = setup();
    if (failInitially)
      harness.browserMock.storage.local.setAccessLevel.mockRejectedValue(
        new Error("synthetic policy failure"),
      );
    bootReviewerListPage(ctx);
    if (failInitially) {
      await expect(client.read()).rejects.toThrow("ui_state_unavailable");
      expect(fetch).not.toHaveBeenCalled();
      harness.browserMock.storage.local.setAccessLevel.mockResolvedValue();
      await harness.restart();
      // The production client reconnects after the actual port disconnect.
      await waitFor(() =>
        expect(harness.notifications.get("content-1")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "snapshot" }),
          ]),
        ),
      );
    }
    await waitFor(() =>
      expect(
        document.querySelector("a.ghpsr-avatar")?.getAttribute("aria-label"),
      ).toContain("alice"),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/repos/octo/repo/pulls",
      "/repos/octo/repo/pulls/42/reviews",
    ]);
    const calls = harness.browserMock.runtime.sendMessage.mock.calls.length;

    await patch({ showReviewerName: true });
    expect(document.querySelector("a.ghpsr-pill")?.textContent).toContain(
      "@alice",
    );
    await patch({ showStateBadge: false });
    expect(document.querySelector(".ghpsr-status")).toBeNull();
    await patch({ openPullsOnly: false });
    const link = document.querySelector<HTMLAnchorElement>("a.ghpsr-pill")!;
    expect(new URL(link.href).searchParams.get("q")).toBe(
      "is:pr review-requested:alice",
    );
    for (const locale of SUPPORTED_LOCALES) {
      await patch({ language: locale });
      const root = document.querySelector<HTMLElement>("[data-ghpsr-root]")!;
      expect(root.lang).toBe(toLanguageTag(locale));
      expect(root.textContent).toContain(
        createTranslator(locale)("reviewers_section"),
      );
      expect(harness.browserMock.runtime.sendMessage).toHaveBeenCalledTimes(
        calls,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  },
);

it("keeps newer subscription preferences when the initial read settles late", async () => {
  const { client, fetch, ctx, patch } = setup();
  const releaseReads = deferred<void>();
  const read = client.read.bind(client);
  vi.spyOn(client, "read").mockImplementation(async () => {
    const snapshot = await read();
    await releaseReads.promise;
    return snapshot;
  });
  bootReviewerListPage(ctx);
  await read();
  await patch({
    showReviewerName: true,
    showStateBadge: false,
    openPullsOnly: false,
  });
  releaseReads.resolve();
  await drain();
  await waitFor(() =>
    expect(document.querySelector("a.ghpsr-pill")).not.toBeNull(),
  );
  // A replaced GitHub row also reads the controller's preferences after the
  // delayed initial response, so a stale overwrite cannot hide in old DOM.
  const row = document.querySelector(".js-issue-row")!;
  const replacement = row.cloneNode(true) as HTMLElement;
  replacement.querySelector("[data-ghpsr-reviewer-meta]")!.remove();
  row.replaceWith(replacement);
  await waitFor(() =>
    expect(document.querySelector("a.ghpsr-pill")).not.toBeNull(),
  );
  const link = document.querySelector<HTMLAnchorElement>("a.ghpsr-pill")!;
  expect(link.textContent).toContain("@alice");
  expect(document.querySelector(".ghpsr-status")).toBeNull();
  expect(new URL(link.href).searchParams.get("q")).toBe(
    "is:pr review-requested:alice",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
