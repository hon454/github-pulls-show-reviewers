import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootAuthBackground,
  connectInput,
  createStorageHarness,
} from "./helpers/auth-harness";

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function boot() {
  const storage = createStorageHarness();
  const background = await bootAuthBackground(storage);
  const { accountMutations } = await import("../src/storage/accounts");
  await accountMutations.initialize();
  return {
    storage,
    background,
    accountMutations,
    wrappers: await import("../src/runtime/account-mutations"),
  };
}
const allowed = (
  background: Awaited<ReturnType<typeof boot>>["background"],
) => ({
  id: background.id,
  url: background.optionsUrl,
  documentId: "options-doc",
});
async function response(
  background: Awaited<ReturnType<typeof boot>>["background"],
  message: unknown,
  sender = allowed(background),
) {
  return new Promise((resolve) => {
    const channel = background.listener(message, sender, resolve);
    if (channel !== true) resolve(channel);
  });
}
describe("real background credential capability retirement and async dispatch", () => {
  it.each([
    "refreshAccessToken",
    "invalidateAccessToken",
    "upsertAccountByLogin",
  ])(
    "rejects retired %s from both options and content without writes or logging",
    async (type) => {
      const { storage, background, accountMutations } = await boot();
      await accountMutations.upsertAccountByLogin(connectInput());
      const before = storage.snapshot();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      for (const sender of [
        allowed(background),
        {
          ...allowed(background),
          url: "https://github.com/octo/repo/pulls",
          tab: { id: 1 },
          frameId: 0,
        },
      ]) {
        for (const message of [
          { type },
          { type, accountId: "acc-1", generation: "g0" },
          { type, input: connectInput() },
        ]) {
          expect(await response(background, message, sender)).toEqual({
            ok: false,
            error: "invalid-request",
          });
        }
      }
      expect(storage.snapshot()).toEqual(before);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("rejects unauthorized removal and malformed allowed requests without changing the registry", async () => {
    const { storage, background, accountMutations } = await boot();
    await accountMutations.upsertAccountByLogin(connectInput());
    const before = storage.snapshot();
    for (const sender of [
      { ...allowed(background), id: "foreign" },
      { ...allowed(background), documentId: "" },
      {
        ...allowed(background),
        url: "https://github.com/octo/repo/pulls",
        tab: { id: 1 },
        frameId: 0,
      },
      { ...allowed(background), url: `${background.optionsUrl}/nested` },
      {
        ...allowed(background),
        url: "chrome-extension://foreign/options.html",
      },
    ]) {
      const result = await response(
        background,
        { type: "removeAccount", accountId: "acc-1" },
        sender,
      );
      expect(
        result === undefined ||
          (result as { error: string }).error === "forbidden",
      ).toBe(true);
    }
    for (const message of [
      null,
      { type: "removeAccount" },
      { type: "removeAccount", accountId: " " },
      { type: "removeAccount", accountId: "acc-1", token: "synthetic" },
    ]) {
      expect(await response(background, message)).toEqual({
        ok: false,
        error: "invalid-request",
      });
    }
    expect(storage.snapshot()).toEqual(before);
  });

  it("keeps Chrome's async channel open and replies only after a successful removal", async () => {
    const { storage, background, accountMutations } = await boot();
    await accountMutations.upsertAccountByLogin(connectInput());
    const barrier = storage.pauseSet();
    const send = vi.fn();
    expect(
      background.listener(
        { type: "removeAccount", accountId: "acc-1" },
        allowed(background),
        send,
      ),
    ).toBe(true);
    await barrier.entered.promise;
    expect(send).not.toHaveBeenCalled();
    barrier.release.resolve();
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({ ok: true, data: null }),
    );
    expect(await accountMutations.listAccounts()).toEqual([]);
  });

  it("reports a sanitized removal failure and permits a later wrapper retry", async () => {
    const { storage, wrappers, accountMutations } = await boot();
    const account = await accountMutations.upsertAccountByLogin(connectInput());
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    storage.local.set.mockRejectedValueOnce(
      new Error("SYNTHETIC_STORAGE_SECRET"),
    );
    await expect(wrappers.removeAccount(account.id)).rejects.toThrow(
      "unavailable",
    );
    expect(
      (await accountMutations.listAccounts()).map((item) => item.id),
    ).toEqual([account.id]);
    await wrappers.removeAccount(account.id);
    expect(await accountMutations.listAccounts()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
});
