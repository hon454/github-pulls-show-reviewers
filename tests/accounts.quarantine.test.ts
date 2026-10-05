import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectInput, createStorageHarness } from "./helpers/auth-harness";

let storage: ReturnType<typeof createStorageHarness>;

beforeEach(() => {
  vi.resetModules();
  storage = createStorageHarness();
  vi.stubGlobal("browser", { storage: { local: storage.local } });
});
afterEach(() => vi.unstubAllGlobals());

const accountKeys = (id: string) => [
  `account:profile:${id}`,
  `account:auth:${id}`,
  `account:installations:${id}`,
];

function accountFragments(id: string) {
  const snapshot = storage.snapshot();
  return Object.fromEntries(accountKeys(id).map((key) => [key, snapshot[key]]));
}

// A newer release added an invalidation reason and an auth field; the rolled
// back schema cannot parse that auth record.
async function seedRollbackRecord() {
  const { accountMutations } = await import("../src/storage/accounts");
  const account = await accountMutations.upsertAccountByLogin(connectInput());
  const key = `account:auth:${account.id}`;
  const auth = storage.snapshot()[key] as Record<string, unknown>;
  await storage.local.set({
    [key]: {
      ...auth,
      invalidated: true,
      invalidatedReason: "future_reason",
      futureField: 1,
    },
  });
  return account;
}

describe("unparseable account records", () => {
  it("quarantines a rollback-style record instead of deleting its credentials", async () => {
    const seeded = await seedRollbackRecord();
    const before = accountFragments(seeded.id);
    vi.resetModules();
    const { accountMutations, getSettings } =
      await import("../src/storage/accounts");

    await accountMutations.initialize();

    expect(accountFragments(seeded.id)).toEqual(before);
    expect(
      (before[`account:auth:${seeded.id}`] as { refreshToken: string })
        .refreshToken,
    ).toBe("fixture-refresh-0");
    expect((await getSettings()).accountIds).toEqual([seeded.id]);
    const [listed] = await accountMutations.listAccounts();
    expect(listed).toMatchObject({
      id: seeded.id,
      login: "octocat",
      invalidated: true,
      invalidatedReason: "unknown",
      token: "",
      refreshToken: null,
    });
    expect(await accountMutations.getAccountById(seeded.id)).toEqual(listed);
  });

  it("never commits credentials over a quarantined record", async () => {
    const seeded = await seedRollbackRecord();
    vi.resetModules();
    const { accountMutations } = await import("../src/storage/accounts");
    await accountMutations.initialize();
    const before = accountFragments(seeded.id);
    const quarantined = await accountMutations.getAccountById(seeded.id);
    const writes = storage.local.set.mock.calls.length;

    const result = await accountMutations.commitAuth(
      seeded.id,
      quarantined!.credentialGeneration!,
      {
        tokens: {
          token: "fixture-access-1",
          refreshToken: "fixture-refresh-1",
          expiresAt: 2,
          refreshTokenExpiresAt: null,
        },
      },
    );

    expect(result?.invalidated).toBe(true);
    expect(storage.local.set.mock.calls.length).toBe(writes);
    expect(accountFragments(seeded.id)).toEqual(before);
  });

  it("restores the account without sign-in once its record parses again", async () => {
    const seeded = await seedRollbackRecord();
    vi.resetModules();
    const { accountMutations } = await import("../src/storage/accounts");
    await accountMutations.initialize();

    // Re-upgrading to the release that wrote the record makes it parse again.
    const key = `account:auth:${seeded.id}`;
    const auth = storage.snapshot()[key] as Record<string, unknown>;
    await storage.local.set({
      [key]: { ...auth, invalidated: false, invalidatedReason: null },
    });
    vi.resetModules();
    const upgraded = await import("../src/storage/accounts");
    await upgraded.accountMutations.initialize();

    expect(
      await upgraded.accountMutations.getAccountById(seeded.id),
    ).toMatchObject({
      id: seeded.id,
      invalidated: false,
      token: "fixture-access-0",
      refreshToken: "fixture-refresh-0",
    });
  });

  it("replaces the quarantined record when the user signs in again", async () => {
    const seeded = await seedRollbackRecord();
    vi.resetModules();
    const { accountMutations } = await import("../src/storage/accounts");
    await accountMutations.initialize();

    const reconnected = await accountMutations.upsertAccountByLogin(
      connectInput({
        token: "fixture-access-new",
        refreshToken: "fixture-refresh-new",
        newAccountId: "unused",
      }),
    );

    expect(reconnected.id).toBe(seeded.id);
    expect(await accountMutations.listAccounts()).toEqual([
      expect.objectContaining({
        id: seeded.id,
        invalidated: false,
        token: "fixture-access-new",
      }),
    ]);
  });

  it("still drops a registered id that has no stored record", async () => {
    const { accountMutations, getSettings } =
      await import("../src/storage/accounts");
    const kept = await accountMutations.upsertAccountByLogin(connectInput());
    await storage.local.set({
      settings: { version: 4, accountIds: [kept.id, "missing"] },
    });
    vi.resetModules();
    const restarted = await import("../src/storage/accounts");

    await restarted.accountMutations.initialize();

    expect((await getSettings()).accountIds).toEqual([kept.id]);
  });
});

describe("registry read-path cost", () => {
  const scans = () =>
    storage.local.get.mock.calls.filter(([keys]) => keys == null).length;

  it("does not repeat initialization or full scans on owner reads", async () => {
    const { accountMutations } = await import("../src/storage/accounts");
    const first = await accountMutations.upsertAccountByLogin(connectInput());
    const second = await accountMutations.upsertAccountByLogin(
      connectInput({ login: "work", newAccountId: "work" }),
    );
    const scansAfterInit = scans();
    const writes = storage.local.set.mock.calls.length;
    const removals = storage.local.remove.mock.calls.length;
    storage.local.get.mockClear();

    for (let index = 0; index < 5; index += 1) {
      await accountMutations.getAccountById(first.id);
      await accountMutations.listAccounts();
    }

    expect(scans()).toBe(0);
    expect(scansAfterInit).toBe(1);
    expect(storage.local.set.mock.calls.length).toBe(writes);
    expect(storage.local.remove.mock.calls.length).toBe(removals);
    // An account read loads the index and that account's fragments only.
    storage.local.get.mockClear();
    await accountMutations.getAccountById(first.id);
    const requested = storage.local.get.mock.calls.flatMap(([keys]) =>
      Array.isArray(keys) ? keys : [keys],
    );
    expect(requested).not.toEqual(
      expect.arrayContaining([`account:auth:${second.id}`]),
    );
    expect(storage.local.get).toHaveBeenCalledTimes(2);
  });

  it("re-verifies the registry once after a failed write", async () => {
    const { accountMutations } = await import("../src/storage/accounts");
    const removed = await accountMutations.upsertAccountByLogin(connectInput());
    const kept = await accountMutations.upsertAccountByLogin(
      connectInput({ login: "work", newAccountId: "work" }),
    );
    storage.local.remove.mockRejectedValueOnce(
      new Error("storage interruption"),
    );
    await expect(accountMutations.removeAccount(removed.id)).rejects.toThrow(
      "storage interruption",
    );
    storage.local.get.mockClear();

    await accountMutations.getAccountById(kept.id);
    expect(scans()).toBe(1);
    for (const key of accountKeys(removed.id)) {
      expect(key in storage.snapshot()).toBe(false);
    }

    await accountMutations.getAccountById(kept.id);
    await accountMutations.listAccounts();
    expect(scans()).toBe(1);
  });

  it("does not rescan after a successful removal", async () => {
    const { accountMutations } = await import("../src/storage/accounts");
    const removed = await accountMutations.upsertAccountByLogin(connectInput());
    await accountMutations.upsertAccountByLogin(
      connectInput({ login: "work", newAccountId: "work" }),
    );
    await accountMutations.removeAccount(removed.id);
    storage.local.get.mockClear();

    await accountMutations.listAccounts();

    expect(scans()).toBe(0);
  });
});
