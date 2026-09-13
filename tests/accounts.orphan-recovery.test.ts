import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectInput, createStorageHarness } from "./helpers/auth-harness";

const accountKeys = (id: string) => [
  `account:profile:${id}`,
  `account:auth:${id}`,
  `account:installations:${id}`,
];

let storage: ReturnType<typeof createStorageHarness>;

beforeEach(() => {
  vi.resetModules();
  storage = createStorageHarness();
  vi.stubGlobal("browser", { storage: { local: storage.local } });
});
afterEach(() => vi.unstubAllGlobals());

function expectKeys(id: string, present: boolean) {
  const snapshot = storage.snapshot();
  for (const key of accountKeys(id)) {
    expect(key in snapshot).toBe(present);
  }
}

describe("background account orphan recovery", () => {
  it("finishes an interrupted removal on restart and leaves other storage intact", async () => {
    const { accountMutations, getAccountById } =
      await import("../src/storage/accounts");
    const removed = await accountMutations.upsertAccountByLogin(connectInput());
    const retained = await accountMutations.upsertAccountByLogin(
      connectInput({ login: "work", newAccountId: "work" }),
    );
    await storage.local.set({ preferences: { language: "ko" }, other: "keep" });
    storage.local.remove.mockRejectedValueOnce(
      new Error("storage interruption"),
    );

    await expect(accountMutations.removeAccount(removed.id)).rejects.toThrow(
      "storage interruption",
    );
    expectKeys(removed.id, true);
    expect((await getAccountById(retained.id))?.id).toBe(retained.id);
    // The failed owner call can also recover in the same worker; simulate a
    // restart first to exercise the original invisible-record failure mode.
    vi.resetModules();
    const restarted = await import("../src/storage/accounts");
    await restarted.accountMutations.initialize();
    expectKeys(removed.id, false);
    expectKeys(retained.id, true);
    expect(
      (await restarted.accountMutations.listAccounts()).map((a) => a.id),
    ).toEqual([retained.id]);
    expect(storage.snapshot()).toMatchObject({
      preferences: { language: "ko" },
      other: "keep",
    });

    const removeCalls = storage.local.remove.mock.calls.length;
    await restarted.accountMutations.initialize();
    expect(storage.local.remove).toHaveBeenCalledTimes(removeCalls);
  });

  it("cleans markerless older orphans using only account record prefixes", async () => {
    await storage.local.set({
      settings: { version: 4, accountIds: [] },
      "account:profile:old": { id: "old" },
      "account:auth:old": { token: "fixture-old" },
      "account:installations:old": { installations: [] },
      "account:other:old": "keep",
      preferences: { language: "ja" },
    });
    const { accountMutations } = await import("../src/storage/accounts");
    await accountMutations.initialize();
    expectKeys("old", false);
    expect(storage.snapshot()).toMatchObject({
      "account:other:old": "keep",
      preferences: { language: "ja" },
    });
  });

  it("serializes cleanup with reconnection and preserves the new account generation", async () => {
    const { accountMutations } = await import("../src/storage/accounts");
    const old = await accountMutations.upsertAccountByLogin(connectInput());
    const retained = await accountMutations.upsertAccountByLogin(
      connectInput({ login: "work", newAccountId: "work" }),
    );
    storage.local.remove.mockRejectedValueOnce(
      new Error("storage interruption"),
    );
    await expect(accountMutations.removeAccount(old.id)).rejects.toThrow();

    const barrier = storage.pauseGet((keys) => keys == null);
    const cleanup = accountMutations.initialize();
    await barrier.entered.promise;
    const reauthenticate = accountMutations.upsertAccountByLogin(
      connectInput({
        login: "work",
        newAccountId: "unused",
        token: "fixture-work-new",
      }),
    );
    const reconnect = accountMutations.upsertAccountByLogin(
      connectInput({ token: "fixture-access-new", newAccountId: old.id }),
    );
    barrier.release.resolve();
    await cleanup;
    const [replacement, current] = await Promise.all([
      reauthenticate,
      reconnect,
    ]);
    expect(replacement.id).toBe(retained.id);
    expect(replacement.credentialGeneration).not.toBe(
      retained.credentialGeneration,
    );
    expect((await accountMutations.getAccountById(retained.id))?.token).toBe(
      "fixture-work-new",
    );
    expectKeys(retained.id, true);
    expect(current.id).toBe(old.id);
    expect(current.credentialGeneration).not.toBe(old.credentialGeneration);
    expect((await accountMutations.getAccountById(old.id))?.token).toBe(
      "fixture-access-new",
    );
    expectKeys(old.id, true);
  });

  it("recovers failed duplicate and malformed-record deletion after index repair", async () => {
    const { accountMutations, addAccount } =
      await import("../src/storage/accounts");
    const retained =
      await accountMutations.upsertAccountByLogin(connectInput());
    await addAccount({ ...retained, id: "duplicate", createdAt: 10 });
    storage.local.remove.mockRejectedValueOnce(
      new Error("duplicate cleanup failed"),
    );
    await expect(
      accountMutations.upsertAccountByLogin(connectInput()),
    ).rejects.toThrow("duplicate cleanup failed");
    expectKeys("duplicate", true);

    await storage.local.set({
      settings: { version: 4, accountIds: [retained.id, "broken"] },
      "account:profile:broken": { malformed: true },
      "account:auth:broken": { malformed: true },
    });
    storage.local.remove.mockRejectedValueOnce(
      new Error("repair cleanup failed"),
    );
    await expect(accountMutations.initialize()).rejects.toThrow(
      "repair cleanup failed",
    );

    vi.resetModules();
    const restarted = await import("../src/storage/accounts");
    await restarted.accountMutations.initialize();
    expectKeys("duplicate", false);
    expectKeys("broken", false);
    expectKeys(retained.id, true);
    expect(
      (await restarted.accountMutations.listAccounts()).map((a) => a.id),
    ).toEqual([retained.id]);
  });
});
