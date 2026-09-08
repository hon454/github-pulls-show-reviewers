import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootAuthBackground,
  connectInput,
  createHttpHarness,
  createStorageHarness,
  rotated,
} from "./helpers/auth-harness";

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function boot() {
  const storage = createStorageHarness();
  const http = createHttpHarness();
  vi.stubGlobal("fetch", http.fetch);
  const background = await bootAuthBackground(storage);
  const { accountMutations, credentialGeneration } =
    await import("../src/storage/accounts");
  await accountMutations.initialize();
  const wrappers = await import("../src/runtime/account-mutations");
  return {
    storage,
    http,
    background,
    accountMutations,
    credentialGeneration,
    wrappers,
  };
}

describe("real background account message boundary", () => {
  it.each(["upsertAccountByLogin", "removeAccount"])(
    "%s rejects every sender except the exact options page in this extension",
    async (type) => {
      const { storage, http, background, accountMutations } = await boot();
      await accountMutations.upsertAccountByLogin(connectInput());
      const writes = storage.local.set.mock.calls.length;
      const removals = storage.local.remove.mock.calls.length;
      const message =
        type === "upsertAccountByLogin"
          ? {
              type,
              input: connectInput({ token: "fixture-access-replacement" }),
            }
          : { type, accountId: "acc-1" };
      const send = vi.fn();
      for (const sender of [
        {},
        { id: "other", url: background.optionsUrl },
        { id: background.id },
        { id: background.id, url: "https://github.com/octo/repo/pulls" },
        { id: background.id, url: `${background.optionsUrl}?spoof=1` },
        { id: background.id, url: `${background.optionsUrl}/nested` },
        { id: background.id, url: "chrome-extension://other/options.html" },
      ]) {
        expect(background.listener(message, sender, send)).toBeUndefined();
      }
      expect(send.mock.calls.length).toBe(0);
      expect(storage.local.set.mock.calls.length).toBe(writes);
      expect(storage.local.remove.mock.calls.length).toBe(removals);
      expect(http.requests.length).toBe(0);
    },
  );

  it("does not dispatch or log malformed auth and mutation messages from an allowed sender", async () => {
    const { storage, http, background } = await boot();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const writes = storage.local.set.mock.calls.length;
    const send = vi.fn();
    for (const message of [
      null,
      { type: "refreshAccessToken", accountId: "acc-1" },
      { type: "invalidateAccessToken", accountId: "acc-1", generation: " " },
      {
        type: "refreshAccessToken",
        accountId: "acc-1",
        generation: "g0",
        token: "fixture-extra",
      },
      {
        type: "upsertAccountByLogin",
        input: { ...connectInput(), installations: null },
      },
      { type: "removeAccount", accountId: "" },
    ]) {
      expect(
        background.listener(
          message,
          { id: background.id, url: background.optionsUrl },
          send,
        ),
      ).toBeUndefined();
    }
    expect(send.mock.calls.length).toBe(0);
    expect(storage.local.set.mock.calls.length).toBe(writes);
    expect(storage.local.remove.mock.calls.length).toBe(0);
    expect(http.requests.length).toBe(0);
    expect(error.mock.calls.length + warn.mock.calls.length).toBe(0);
  });

  it.each(["refreshAccessToken", "invalidateAccessToken"])(
    "%s requires this extension's sender ID",
    async (type) => {
      const {
        storage,
        http,
        background,
        accountMutations,
        credentialGeneration,
      } = await boot();
      const account =
        await accountMutations.upsertAccountByLogin(connectInput());
      const writes = storage.local.set.mock.calls.length;
      const send = vi.fn();
      for (const sender of [{}, { id: "other", url: background.optionsUrl }]) {
        expect(
          background.listener(
            {
              type,
              accountId: account.id,
              generation: credentialGeneration(account),
            },
            sender,
            send,
          ),
        ).toBeUndefined();
      }
      expect(send.mock.calls.length).toBe(0);
      expect(storage.local.set.mock.calls.length).toBe(writes);
      expect(http.requests.length).toBe(0);
    },
  );

  it("keeps the async auth channel open and returns only the committed generation", async () => {
    const { http, background, accountMutations, credentialGeneration } =
      await boot();
    const account = await accountMutations.upsertAccountByLogin(connectInput());
    let response: unknown;
    const complete = new Promise<void>((resolve) => {
      expect(
        background.listener(
          {
            type: "refreshAccessToken",
            accountId: account.id,
            generation: credentialGeneration(account),
          },
          { id: background.id, url: "https://github.com/octo/repo/pulls" },
          (value) => {
            response = value;
            resolve();
          },
        ),
      ).toBe(true);
    });
    (await http.next()).response.resolve(rotated());
    await complete;
    expect(Object.keys(response as object).sort()).toEqual([
      "generation",
      "ok",
    ]);
    const current = (await accountMutations.getAccountById(account.id))!;
    expect((response as { generation: string }).generation).toBe(
      credentialGeneration(current),
    );
  });

  it("reports sanitized commit/removal failures and admits subsequent wrapper retries", async () => {
    const { storage, wrappers, accountMutations } = await boot();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    storage.local.set.mockRejectedValueOnce(
      new Error("fixture-storage-failure"),
    );
    await expect(wrappers.upsertAccountByLogin(connectInput())).rejects.toThrow(
      "account_commit_failed",
    );
    const account = await wrappers.upsertAccountByLogin(connectInput());
    storage.local.set.mockRejectedValueOnce(
      new Error("fixture-storage-failure"),
    );
    await expect(wrappers.removeAccount(account.id)).rejects.toThrow(
      "account_remove_failed",
    );
    expect((await accountMutations.listAccounts()).map((a) => a.id)).toEqual([
      account.id,
    ]);
    await wrappers.removeAccount(account.id);
    expect((await accountMutations.listAccounts()).length).toBe(0);
    expect(error.mock.calls.length).toBe(0);
  });
});
