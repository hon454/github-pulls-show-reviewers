import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUIBridgeHarness,
  optionsSender,
  contentSender,
  containsSecret,
  SENTINELS,
  drain,
} from "./helpers/ui-bridge-harness";
import { accountMutations } from "../src/storage/accounts";
import { connectInput } from "./helpers/auth-harness";
import { DEFAULT_PREFERENCES } from "../src/shared/preferences";

let harness: ReturnType<typeof createUIBridgeHarness>;
const clients: ReturnType<
  ReturnType<typeof createUIBridgeHarness>["client"]
>[] = [];
beforeEach(() => {
  harness = createUIBridgeHarness();
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  harness.dispose();
  await drain();
  vi.unstubAllGlobals();
});
async function twoClients() {
  const a = harness.client(optionsSender("options-1"));
  const b = harness.client(optionsSender("options-2"));
  clients.push(a, b);
  a.subscribe(() => {});
  b.subscribe(() => {});
  await Promise.all([a.read(), b.read()]);
  return { a, b };
}

describe("two independent options clients against the real background preference owner", () => {
  it("merges different-field partial patches against the latest committed value", async () => {
    const { a, b } = await twoClients();
    const barrier = harness.storage.pauseSet();
    const language = a.patchPreferences({
      type: "patchPreferences",
      patch: { language: "ko" },
    });
    await barrier.entered.promise;
    const display = b.patchPreferences({
      type: "patchPreferences",
      patch: { showReviewerName: true },
    });
    await drain();
    expect(harness.storage.snapshot().preferences).toBeUndefined();
    barrier.release.resolve();
    await Promise.all([language, display]);
    expect(harness.storage.snapshot().preferences).toEqual({
      ...DEFAULT_PREFERENCES,
      language: "ko",
      showReviewerName: true,
    });
    for (const client of [a, b])
      expect((await client.read()).preferences).toEqual(
        harness.storage.snapshot().preferences,
      );
    expect(containsSecret([...harness.notifications.values()])).toBe(false);
  });

  it("orders conflicts on the same field by admission, without a stale snapshot overwrite", async () => {
    const { a, b } = await twoClients();
    const barrier = harness.storage.pauseSet();
    const first = a.patchPreferences({
      type: "patchPreferences",
      patch: { language: "ja" },
    });
    await barrier.entered.promise;
    const second = b.patchPreferences({
      type: "patchPreferences",
      patch: { language: "zh_TW" },
    });
    barrier.release.resolve();
    await Promise.all([first, second]);
    expect(
      harness.storage.local.set.mock.calls.map(
        ([value]) => (value.preferences as { language: string }).language,
      ),
    ).toEqual(["ja", "zh_TW"]);
    expect((await a.read()).preferences.language).toBe("zh_TW");
    expect((await b.read()).preferences.language).toBe("zh_TW");
  });

  it("does not publish before a successful storage write and recovers after a failed write", async () => {
    const { a, b } = await twoClients();
    const received: string[] = [];
    a.subscribe(({ snapshot }) => received.push(snapshot.preferences.language));
    const barrier = harness.storage.pauseSet();
    const first = a.patchPreferences({
      type: "patchPreferences",
      patch: { language: "ja" },
    });
    await barrier.entered.promise;
    await drain();
    expect(received).toEqual([]);
    barrier.release.resolve();
    await first;
    expect(received).toContain("ja");
    harness.storage.local.set.mockRejectedValueOnce(
      new Error(SENTINELS.access),
    );
    await expect(
      b.patchPreferences({
        type: "patchPreferences",
        patch: { language: "ko" },
      }),
    ).rejects.toThrow("unavailable");
    expect(received).not.toContain("ko");
    await b.patchPreferences({
      type: "patchPreferences",
      patch: { language: "en", openPullsOnly: false },
    });
    expect((await a.read()).preferences).toMatchObject({
      language: "en",
      openPullsOnly: false,
    });
    expect(
      containsSecret([harness.replies, [...harness.notifications.values()]]),
    ).toBe(false);
  });

  it.each<Record<string, unknown>>([
    { token: SENTINELS.access },
    { settings: {} },
    { version: 99 },
    { language: "de" },
    { showReviewerName: "true" },
    { __proto__: null, constructor: {} },
  ])(
    "rejects invalid/unknown patch %# without changing account data",
    async (patch) => {
      await accountMutations.upsertAccountByLogin(
        connectInput({
          token: SENTINELS.access,
          refreshToken: SENTINELS.refresh,
        }),
      );
      await harness.initialize();
      const before = harness.storage.snapshot();
      expect(await harness.send({ type: "patchPreferences", patch })).toEqual({
        ok: false,
        error: "invalid-request",
      });
      expect(harness.storage.snapshot()).toEqual(before);
      expect(containsSecret(harness.replies)).toBe(false);
    },
  );

  it("broadcasts safe settings to multiple documents while keeping accounts and diagnostic replies scoped", async () => {
    const { a, b } = await twoClients();
    const c = harness.client(contentSender());
    clients.push(c);
    c.subscribe(() => {});
    await c.read();
    const originalAccountRevision = (await c.read()).accountsRevision;
    for (const language of ["en", "ko", "ja", "zh_CN", "zh_TW"] as const) {
      await a.patchPreferences({
        type: "patchPreferences",
        patch: { language },
      });
      expect((await b.read()).preferences.language).toBe(language);
      expect((await c.read()).preferences.language).toBe(language);
      expect((await c.read()).accountsRevision).toBe(originalAccountRevision);
    }
    await b.patchPreferences({
      type: "patchPreferences",
      patch: {
        showStateBadge: false,
        showReviewerName: true,
        openPullsOnly: false,
      },
    });
    expect((await c.read()).preferences).toMatchObject({
      showStateBadge: false,
      showReviewerName: true,
      openPullsOnly: false,
    });
    expect((await c.read()).accounts).toBeNull();
    expect(containsSecret([...harness.notifications.values()])).toBe(false);
  });
});
