import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectInput, createStorageHarness } from "./helpers/auth-harness";

let storage: ReturnType<typeof createStorageHarness>;

beforeEach(() => {
  vi.resetModules();
  storage = createStorageHarness();
  vi.stubGlobal("browser", { storage: { local: storage.local } });
});
afterEach(() => vi.unstubAllGlobals());

async function load() {
  return import("../src/storage/accounts");
}

// Simulate a record written before the numeric user id was stored.
async function stripUserId(accountId: string) {
  const key = `account:profile:${accountId}`;
  const profile = storage.snapshot()[key] as Record<string, unknown>;
  delete profile.userId;
  await storage.local.set({ [key]: profile });
}

describe("accounts keyed on the GitHub user id", () => {
  it("stores the numeric user id with the profile", async () => {
    const { accountMutations } = await load();
    const account = await accountMutations.upsertAccountByLogin(
      connectInput({ userId: 42 }),
    );
    expect(account.userId).toBe(42);
    expect(storage.snapshot()[`account:profile:${account.id}`]).toMatchObject({
      userId: 42,
      login: "octocat",
    });
  });

  it("updates the same record when a renamed user signs in again", async () => {
    const { accountMutations } = await load();
    const original = await accountMutations.upsertAccountByLogin(
      connectInput({ userId: 42, login: "old-name" }),
    );

    const renamed = await accountMutations.upsertAccountByLogin(
      connectInput({
        userId: 42,
        login: "new-name",
        token: "fixture-access-renamed",
        newAccountId: "unused",
      }),
    );

    expect(renamed.id).toBe(original.id);
    expect(renamed.createdAt).toBe(original.createdAt);
    expect(renamed.credentialGeneration).not.toBe(
      original.credentialGeneration,
    );
    expect(await accountMutations.listAccounts()).toEqual([
      expect.objectContaining({
        id: original.id,
        userId: 42,
        login: "new-name",
        token: "fixture-access-renamed",
      }),
    ]);
  });

  it("keeps a different user who reuses a login as a separate account", async () => {
    const { accountMutations } = await load();
    const first = await accountMutations.upsertAccountByLogin(
      connectInput({ userId: 42, login: "octocat" }),
    );
    const second = await accountMutations.upsertAccountByLogin(
      connectInput({ userId: 7, login: "OctoCat", newAccountId: "acc-2" }),
    );

    expect(second.id).not.toBe(first.id);
    expect(
      (await accountMutations.listAccounts()).map((a) => a.userId),
    ).toEqual([42, 7]);
  });
});

describe("records without a stored user id", () => {
  it("stay valid without re-authentication", async () => {
    const seeded = await (
      await load()
    ).accountMutations.upsertAccountByLogin(connectInput());
    await stripUserId(seeded.id);
    vi.resetModules();
    const { accountMutations } = await load();
    await accountMutations.initialize();

    const account = await accountMutations.getAccountById(seeded.id);
    expect(account).toMatchObject({
      id: seeded.id,
      invalidated: false,
      token: "fixture-access-0",
    });
    expect(account?.userId).toBeUndefined();
  });

  it("are backfilled by the next sign-in with the same login", async () => {
    const { accountMutations } = await load();
    const seeded = await accountMutations.upsertAccountByLogin(connectInput());
    await stripUserId(seeded.id);

    const reconnected = await accountMutations.upsertAccountByLogin(
      connectInput({ userId: 42, newAccountId: "unused" }),
    );

    expect(reconnected.id).toBe(seeded.id);
    expect(storage.snapshot()[`account:profile:${seeded.id}`]).toMatchObject({
      userId: 42,
    });
  });

  it("are backfilled from a later /user response under the current revision", async () => {
    const { accountMutations } = await load();
    const seeded = await accountMutations.upsertAccountByLogin(connectInput());
    await stripUserId(seeded.id);
    const before = await accountMutations.getAccountById(seeded.id);

    const outcome = await accountMutations.backfillUserId(
      seeded.id,
      before!.credentialGeneration!,
      { userId: 42, login: "octocat-renamed", avatarUrl: null },
    );

    expect(outcome).toBe("committed");
    expect(await accountMutations.getAccountById(seeded.id)).toMatchObject({
      userId: 42,
      login: "octocat-renamed",
      token: "fixture-access-0",
      credentialGeneration: before!.credentialGeneration,
    });
  });

  it("skip a backfill from an obsolete revision or for an invalidated account", async () => {
    const { accountMutations } = await load();
    const seeded = await accountMutations.upsertAccountByLogin(connectInput());
    await stripUserId(seeded.id);
    const user = { userId: 42, login: "octocat", avatarUrl: null };

    expect(
      await accountMutations.backfillUserId(seeded.id, "obsolete", user),
    ).toBe("skipped");
    const current = await accountMutations.commitAuth(
      seeded.id,
      seeded.credentialGeneration!,
      { invalidatedReason: "revoked" },
    );
    expect(
      await accountMutations.backfillUserId(
        seeded.id,
        current!.credentialGeneration!,
        user,
      ),
    ).toBe("skipped");
    expect(
      (await accountMutations.getAccountById(seeded.id))?.userId,
    ).toBeUndefined();
  });

  it("never overwrite an id that is already stored", async () => {
    const { accountMutations } = await load();
    const account = await accountMutations.upsertAccountByLogin(
      connectInput({ userId: 42 }),
    );
    expect(
      await accountMutations.backfillUserId(
        account.id,
        account.credentialGeneration!,
        { userId: 7, login: "octocat", avatarUrl: null },
      ),
    ).toBe("skipped");
    expect((await accountMutations.getAccountById(account.id))?.userId).toBe(
      42,
    );
  });

  it("merge into the account that already holds the id after a rename", async () => {
    const { accountMutations, getSettings } = await load();
    const stale = await accountMutations.upsertAccountByLogin(
      connectInput({ login: "old-name" }),
    );
    await stripUserId(stale.id);
    // The user renamed on GitHub and signed in again before the backfill ran.
    const current = await accountMutations.upsertAccountByLogin(
      connectInput({
        userId: 42,
        login: "new-name",
        token: "fixture-access-new",
        newAccountId: "acc-new",
      }),
    );
    expect(current.id).not.toBe(stale.id);

    const outcome = await accountMutations.backfillUserId(
      stale.id,
      stale.credentialGeneration!,
      { userId: 42, login: "new-name", avatarUrl: null },
    );

    expect(outcome).toBe("merged");
    expect((await getSettings()).accountIds).toEqual([current.id]);
    for (const prefix of ["profile", "auth", "installations"]) {
      expect(`account:${prefix}:${stale.id}` in storage.snapshot()).toBe(false);
    }
    expect(await accountMutations.listAccounts()).toEqual([
      expect.objectContaining({ id: current.id, token: "fixture-access-new" }),
    ]);
  });

  it("refresh the kept record's login and avatar when they merge", async () => {
    const { accountMutations } = await load();
    const keyed = await accountMutations.upsertAccountByLogin(
      connectInput({ userId: 42, login: "older-name", newAccountId: "keyed" }),
    );
    const legacy = await accountMutations.upsertAccountByLogin(
      connectInput({ login: "legacy-name", newAccountId: "legacy" }),
    );
    await stripUserId(legacy.id);

    await accountMutations.backfillUserId(
      legacy.id,
      legacy.credentialGeneration!,
      {
        userId: 42,
        login: "current-name",
        avatarUrl: "https://avatars.githubusercontent.com/u/42",
      },
    );

    expect(await accountMutations.getAccountById(keyed.id)).toMatchObject({
      login: "current-name",
      avatarUrl: "https://avatars.githubusercontent.com/u/42",
      token: keyed.token,
      credentialGeneration: keyed.credentialGeneration,
    });
  });

  it("drop an invalidated record that holds the id and keep the valid one", async () => {
    const { accountMutations, getSettings } = await load();
    const revoked = await accountMutations.upsertAccountByLogin(
      connectInput({ userId: 42, login: "new-name", newAccountId: "revoked" }),
    );
    await accountMutations.commitAuth(
      revoked.id,
      revoked.credentialGeneration!,
      { invalidatedReason: "revoked" },
    );
    const legacy = await accountMutations.upsertAccountByLogin(
      connectInput({ login: "old-name", newAccountId: "legacy" }),
    );
    await stripUserId(legacy.id);

    const outcome = await accountMutations.backfillUserId(
      legacy.id,
      legacy.credentialGeneration!,
      { userId: 42, login: "new-name", avatarUrl: null },
    );

    expect(outcome).toBe("committed");
    expect((await getSettings()).accountIds).toEqual([legacy.id]);
    for (const prefix of ["profile", "auth", "installations"]) {
      expect(`account:${prefix}:${revoked.id}` in storage.snapshot()).toBe(
        false,
      );
    }
    expect(await accountMutations.getAccountById(legacy.id)).toMatchObject({
      userId: 42,
      login: "new-name",
      token: legacy.token,
      invalidated: false,
    });
  });

  it("never drop a quarantined record that holds the id", async () => {
    const { accountMutations, getSettings } = await load();
    const quarantined = await accountMutations.upsertAccountByLogin(
      connectInput({ userId: 42, login: "new-name", newAccountId: "unread" }),
    );
    await storage.local.set({
      [`account:auth:${quarantined.id}`]: { unreadable: true },
    });
    const legacy = await accountMutations.upsertAccountByLogin(
      connectInput({ login: "old-name", newAccountId: "legacy" }),
    );
    await stripUserId(legacy.id);

    expect(
      await accountMutations.backfillUserId(
        legacy.id,
        legacy.credentialGeneration!,
        { userId: 42, login: "new-name", avatarUrl: null },
      ),
    ).toBe("committed");
    expect((await getSettings()).accountIds).toEqual([
      quarantined.id,
      legacy.id,
    ]);
    expect(storage.snapshot()[`account:auth:${quarantined.id}`]).toEqual({
      unreadable: true,
    });
  });

  it("consolidate a keyed record and a login-only record on sign-in", async () => {
    const { accountMutations, getSettings } = await load();
    const keyed = await accountMutations.upsertAccountByLogin(
      connectInput({ userId: 42, login: "bob", newAccountId: "keyed", now: 1 }),
    );
    const legacy = await accountMutations.upsertAccountByLogin(
      connectInput({ login: "alice", newAccountId: "legacy", now: 2 }),
    );
    await stripUserId(legacy.id);

    const signedIn = await accountMutations.upsertAccountByLogin(
      connectInput({
        userId: 42,
        login: "alice",
        token: "fixture-access-signed-in",
        newAccountId: "unused",
      }),
    );

    expect(signedIn.id).toBe(keyed.id);
    expect((await getSettings()).accountIds).toEqual([keyed.id]);
    for (const prefix of ["profile", "auth", "installations"]) {
      expect(`account:${prefix}:${legacy.id}` in storage.snapshot()).toBe(
        false,
      );
    }
    expect(await accountMutations.getAccountById(keyed.id)).toMatchObject({
      userId: 42,
      login: "alice",
      token: "fixture-access-signed-in",
    });
  });
});
