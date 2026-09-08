import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountMutations,
  getAccountById,
  getSettings,
  listAccounts,
} from "../src/storage/accounts";
import {
  upsertAccountByLogin,
  removeAccount,
} from "../src/runtime/account-mutations";
import {
  bootAuthBackground,
  connectInput,
  createStorageHarness,
} from "./helpers/auth-harness";

let storage: ReturnType<typeof createStorageHarness>;
beforeEach(() => {
  storage = createStorageHarness();
});
afterEach(() => vi.unstubAllGlobals());

async function boot() {
  await bootAuthBackground(storage);
  await accountMutations.initialize();
}
async function assertReachable(expected: string[]) {
  const settings = await getSettings();
  expect([...settings.accountIds].sort()).toEqual([...expected].sort());
  expect((await listAccounts()).map((a) => a.id).sort()).toEqual(
    [...expected].sort(),
  );
  const keys = Object.keys(storage.snapshot());
  for (const prefix of [
    "account:profile:",
    "account:auth:",
    "account:installations:",
  ]) {
    expect(
      keys
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .sort(),
    ).toEqual([...expected].sort());
  }
}

describe("one background registry owner across options callers", () => {
  it("retains concurrent different-login additions across a paused registry read", async () => {
    await boot();
    const unrelated = await upsertAccountByLogin(
      connectInput({ login: "unrelated", newAccountId: "existing" }),
    );
    const barrier = storage.pauseGet((keys) => keys === "settings");
    const a = upsertAccountByLogin(connectInput());
    await barrier.entered.promise;
    const b = upsertAccountByLogin(
      connectInput({ login: "other", newAccountId: "acc-2" }),
    );
    barrier.release.resolve();
    const [first, second] = await Promise.all([a, b]);
    await assertReachable([unrelated.id, first.id, second.id]);
  });

  it("resolves simultaneous same-login sign-ins with different proposed IDs to one identity", async () => {
    await boot();
    const unrelated = await upsertAccountByLogin(
      connectInput({ login: "unrelated", newAccountId: "existing" }),
    );
    const barrier = storage.pauseSet();
    const a = upsertAccountByLogin(connectInput());
    await barrier.entered.promise;
    const b = upsertAccountByLogin(
      connectInput({
        login: "OctoCat",
        newAccountId: "different-id",
        token: "fixture-access-second",
      }),
    );
    barrier.release.resolve();
    const [first, second] = await Promise.all([a, b]);
    expect(first.id).toBe(second.id);
    expect(first.credentialGeneration === second.credentialGeneration).toBe(
      false,
    );
    expect((await getAccountById(first.id))?.token === second.token).toBe(true);
    await assertReachable([unrelated.id, first.id]);
  });

  it.each(["add", "remove"])(
    "serializes add/remove when %s reaches storage first",
    async (first) => {
      await boot();
      await upsertAccountByLogin(
        connectInput({ login: "unrelated", newAccountId: "existing" }),
      );
      const removed = await upsertAccountByLogin(connectInput());
      const add = () =>
        upsertAccountByLogin(
          connectInput({ login: "other", newAccountId: "acc-2" }),
        );
      const remove = () => removeAccount(removed.id);
      const barrier = storage.pauseSet();
      const a = first === "add" ? add() : remove();
      await barrier.entered.promise;
      const b = first === "add" ? remove() : add();
      barrier.release.resolve();
      await Promise.all([a, b]);
      await assertReachable(["existing", "acc-2"]);
      expect((await getAccountById(removed.id)) == null).toBe(true);
    },
  );

  it("a query with an old registry snapshot never repairs over a concurrent addition", async () => {
    await boot();
    await upsertAccountByLogin(connectInput());
    await storage.local.set({
      settings: { version: 4, accountIds: ["acc-1", "broken"] },
      "account:auth:broken": { malformed: true },
    });
    const barrier = storage.pauseGet((keys) => keys === "settings");
    const query = listAccounts();
    await barrier.entered.promise;
    await upsertAccountByLogin(
      connectInput({ login: "other", newAccountId: "acc-2" }),
    );
    barrier.release.resolve();
    expect((await query).map((a) => a.id)).toEqual(["acc-1"]);
    await assertReachable(["acc-1", "acc-2"]);
  });

  it("owner repair and addition use the same short commit boundary", async () => {
    await boot();
    await upsertAccountByLogin(connectInput());
    await storage.local.set({
      settings: { version: 4, accountIds: ["acc-1", "broken"] },
      "account:profile:broken": { malformed: true },
    });
    const barrier = storage.pauseSet();
    const repair = accountMutations.listAccounts();
    await barrier.entered.promise;
    const add = upsertAccountByLogin(
      connectInput({ login: "other", newAccountId: "acc-2" }),
    );
    barrier.release.resolve();
    await Promise.all([repair, add]);
    await assertReachable(["acc-1", "acc-2"]);
  });

  it.each([2, 3])(
    "finishes v%s migration before admitting concurrent options additions",
    async (version) => {
      const input = connectInput();
      await storage.local.set({
        settings: {
          version,
          accounts: [
            {
              id: "legacy",
              login: "legacy-user",
              avatarUrl: null,
              token: input.token,
              createdAt: 1,
              installations: [],
              installationsRefreshedAt: 1,
              invalidated: false,
              invalidatedReason: null,
              ...(version === 3
                ? {
                    refreshToken: input.refreshToken,
                    expiresAt: 1,
                    refreshTokenExpiresAt: null,
                  }
                : {}),
            },
          ],
        },
      });
      const barrier = storage.pauseSet();
      await bootAuthBackground(storage);
      await barrier.entered.promise;
      // A context query reads legacy state but does not trigger its own migration.
      const writesBeforeQuery = storage.local.set.mock.calls.length;
      expect((await listAccounts()).map((a) => a.id)).toEqual(["legacy"]);
      expect(storage.local.set.mock.calls.length).toBe(writesBeforeQuery);
      const a = upsertAccountByLogin(connectInput());
      const b = upsertAccountByLogin(
        connectInput({ login: "other", newAccountId: "acc-2" }),
      );
      barrier.release.resolve();
      await Promise.all([a, b]);
      await assertReachable(["legacy", "acc-1", "acc-2"]);
      expect((await getAccountById("legacy"))?.credentialGeneration).toEqual(
        expect.any(String),
      );
    },
  );

  it("persists a legacy revision once and preserves it across reads and worker restart", async () => {
    await boot();
    await upsertAccountByLogin(connectInput());
    const key = "account:auth:acc-1";
    const auth = storage.snapshot()[key] as Record<string, unknown>;
    delete auth.credentialGeneration;
    await storage.local.set({ [key]: auth });
    expect(
      (await getAccountById("acc-1"))?.credentialGeneration,
    ).toBeUndefined();
    await accountMutations.initialize();
    expect(Object.keys(storage.local.set.mock.calls.at(-1)![0])).toEqual([key]);
    const generation = (await getAccountById("acc-1"))?.credentialGeneration;
    expect(typeof generation).toBe("string");
    const writes = storage.local.set.mock.calls.length;
    await listAccounts();
    await getAccountById("acc-1");
    vi.resetModules();
    const restarted = await import("../src/storage/accounts");
    await restarted.accountMutations.initialize();
    expect(
      (await restarted.getAccountById("acc-1"))?.credentialGeneration,
    ).toBe(generation);
    expect(storage.local.set.mock.calls.length).toBe(writes);
  });

  it("consolidates legacy duplicate logins without orphaning their fragments", async () => {
    await boot();
    const { addAccount } = await import("../src/storage/accounts");
    const current = await upsertAccountByLogin(connectInput());
    await addAccount({ ...current, id: "duplicate", createdAt: 10 });
    const retained = await upsertAccountByLogin(
      connectInput({ login: "OctoCat", newAccountId: "unused" }),
    );
    expect(retained.id).toBe(current.id);
    await assertReachable([current.id]);
  });
});
