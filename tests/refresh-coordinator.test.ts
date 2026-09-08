import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRefreshCoordinator } from "../src/auth/refresh-coordinator";
import {
  accountMutations,
  credentialGeneration,
} from "../src/storage/accounts";
import {
  connectInput,
  createHttpHarness,
  createStorageHarness,
  json,
  rotated,
} from "./helpers/auth-harness";

let storage: ReturnType<typeof createStorageHarness>;
let http: ReturnType<typeof createHttpHarness>;
let coordinator: ReturnType<typeof createRefreshCoordinator>;
beforeEach(() => {
  storage = createStorageHarness();
  http = createHttpHarness();
  vi.stubGlobal("browser", { storage: { local: storage.local } });
  vi.stubGlobal("fetch", http.fetch);
  coordinator = createRefreshCoordinator({ getClientId: () => "test-client" });
});
afterEach(() => vi.unstubAllGlobals());

describe("generation-aware refresh coordinator with real storage and HTTP parsing", () => {
  it("rotates credentials once for concurrent failures and reuses them for a delayed 401", async () => {
    const old = await accountMutations.upsertAccountByLogin(connectInput());
    const a = coordinator.refreshAccountToken(
      old.id,
      credentialGeneration(old),
    );
    const b = coordinator.refreshAccountToken(
      old.id,
      credentialGeneration(old),
    );
    const request = await http.next();
    expect(request.kind).toBe("refresh");
    request.response.resolve(rotated());
    const [first, second] = await Promise.all([a, b]);
    expect(first.ok && second.ok).toBe(true);
    expect(first).toEqual(second);
    const late = await coordinator.refreshAccountToken(
      old.id,
      credentialGeneration(old),
    );
    expect(late).toEqual(first);
    expect(http.requests.length).toBe(1);
    const current = await accountMutations.getAccountById(old.id);
    expect(current?.invalidated).toBe(false);
    expect(current?.credentialGeneration !== old.credentialGeneration).toBe(
      true,
    );
    expect(current?.token === "fixture-access-1").toBe(true);
  });

  it("preserves omitted refresh rotation fields", async () => {
    const old = await accountMutations.upsertAccountByLogin(
      connectInput({ refreshTokenExpiresAt: 999 }),
    );
    const work = coordinator.refreshAccountToken(
      old.id,
      credentialGeneration(old),
    );
    (await http.next()).response.resolve(rotated("1", true));
    expect((await work).ok).toBe(true);
    const current = await accountMutations.getAccountById(old.id);
    expect(current?.refreshToken === old.refreshToken).toBe(true);
    expect(current?.refreshTokenExpiresAt).toBe(999);
  });

  it.each(["success", "terminal"])(
    "does not overwrite reauthentication on old refresh %s",
    async (result) => {
      const old = await accountMutations.upsertAccountByLogin(connectInput());
      const work = coordinator.refreshAccountToken(
        old.id,
        credentialGeneration(old),
      );
      const pending = await http.next();
      const signedIn = await accountMutations.upsertAccountByLogin(
        connectInput({ token: "fixture-access-login" }),
      );
      pending.response.resolve(
        result === "success"
          ? rotated()
          : json({ error: "bad_refresh_token" }, 400),
      );
      expect(await work).toEqual({
        ok: true,
        generation: credentialGeneration(signedIn),
      });
      const current = await accountMutations.getAccountById(old.id);
      expect(current?.credentialGeneration).toBe(signedIn.credentialGeneration);
      expect(current?.invalidated).toBe(false);
      expect(current?.token === signedIn.token).toBe(true);
    },
  );

  it.each(["success", "terminal"])(
    "does not resurrect removal on old refresh %s",
    async (result) => {
      const old = await accountMutations.upsertAccountByLogin(connectInput());
      const work = coordinator.refreshAccountToken(
        old.id,
        credentialGeneration(old),
      );
      const pending = await http.next();
      await accountMutations.removeAccount(old.id);
      pending.response.resolve(
        result === "success"
          ? rotated()
          : json({ error: "bad_refresh_token" }, 400),
      );
      expect(await work).toEqual({ ok: false, terminal: true });
      expect((await accountMutations.getAccountById(old.id)) == null).toBe(
        true,
      );
      expect(
        Object.keys(storage.snapshot()).filter((key) =>
          key.startsWith("account:"),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    [json({ error: "bad_refresh_token" }, 400), true],
    [json({}, 401), true],
    [json({}, 503), false],
    [json({}, 429), false],
    [json({ malformed: true }), false],
  ])(
    "preserves terminal/transient classification %#",
    async (response, terminal) => {
      const old = await accountMutations.upsertAccountByLogin(connectInput());
      const work = coordinator.refreshAccountToken(
        old.id,
        credentialGeneration(old),
      );
      (await http.next()).response.resolve(response);
      expect(await work).toEqual({ ok: false, terminal });
      const current = await accountMutations.getAccountById(old.id);
      expect(current?.invalidated).toBe(terminal);
      expect(current?.invalidatedReason).toBe(
        terminal ? "refresh_failed" : null,
      );
    },
  );

  it("leaves current credentials active after network failure", async () => {
    const old = await accountMutations.upsertAccountByLogin(connectInput());
    const work = coordinator.refreshAccountToken(
      old.id,
      credentialGeneration(old),
    );
    (await http.next()).response.reject(new Error("network"));
    expect(await work).toEqual({ ok: false, terminal: false });
    expect((await accountMutations.getAccountById(old.id))?.invalidated).toBe(
      false,
    );
  });

  it("checks generation before the missing-refresh-token branch and invalidates only a current failure", async () => {
    const old = await accountMutations.upsertAccountByLogin(
      connectInput({ refreshToken: null }),
    );
    const signedIn = await accountMutations.upsertAccountByLogin(
      connectInput({ refreshToken: null, token: "fixture-access-login" }),
    );
    expect(
      await coordinator.refreshAccountToken(old.id, credentialGeneration(old)),
    ).toEqual({ ok: true, generation: credentialGeneration(signedIn) });
    expect((await accountMutations.getAccountById(old.id))?.invalidated).toBe(
      false,
    );
    expect(
      await coordinator.refreshAccountToken(
        old.id,
        credentialGeneration(signedIn),
      ),
    ).toEqual({ ok: false, terminal: true });
    expect(
      (await accountMutations.getAccountById(old.id))?.invalidatedReason,
    ).toBe("revoked");
    expect(http.requests.length).toBe(0);
  });

  it("conditionally invalidates the used retry generation", async () => {
    const old = await accountMutations.upsertAccountByLogin(connectInput());
    const signedIn = await accountMutations.upsertAccountByLogin(
      connectInput({ token: "fixture-access-login" }),
    );
    await coordinator.invalidateAccountToken(old.id, credentialGeneration(old));
    expect((await accountMutations.getAccountById(old.id))?.invalidated).toBe(
      false,
    );
    await coordinator.invalidateAccountToken(
      old.id,
      credentialGeneration(signedIn),
    );
    expect(
      (await accountMutations.getAccountById(old.id))?.invalidatedReason,
    ).toBe("revoked");
  });

  it.each(["no-refresh-token", "expired"])(
    "rechecks a %s decision when a sign-in is queued before invalidation commit",
    async (kind) => {
      const now = Date.now();
      const old = await accountMutations.upsertAccountByLogin(
        connectInput({
          refreshToken:
            kind === "no-refresh-token" ? null : "fixture-refresh-0",
          refreshTokenExpiresAt: now - 1,
        }),
      );
      let fragmentReads = 0;
      // Initialization reads fragments first; hold the subsequent decision
      // snapshot after storage captured it, then queue a real options commit.
      const barrier = storage.pauseGet(
        (keys) => Array.isArray(keys) && ++fragmentReads === 2,
      );
      const recovery =
        kind === "expired"
          ? coordinator.refreshAccountIfDue(old.id, now)
          : coordinator.refreshAccountToken(old.id, credentialGeneration(old));
      await barrier.entered.promise;
      const signIn = accountMutations.upsertAccountByLogin(
        connectInput({
          token: "fixture-access-login",
          expiresAt: now + 10_000_000,
        }),
      );
      barrier.release.resolve();
      const signedIn = await signIn;
      expect(await recovery).toEqual({
        ok: true,
        generation: credentialGeneration(signedIn),
      });
      expect((await accountMutations.getAccountById(old.id))?.invalidated).toBe(
        false,
      );
      expect(http.requests.length).toBe(0);
    },
  );

  it("allows unrelated HTTP and registry commits while one account refresh is stalled", async () => {
    const a = await accountMutations.upsertAccountByLogin(connectInput());
    const workA = coordinator.refreshAccountToken(
      a.id,
      credentialGeneration(a),
    );
    const pendingA = await http.next();
    const b = await accountMutations.upsertAccountByLogin(
      connectInput({
        login: "other",
        newAccountId: "acc-2",
        refreshToken: "fixture-refresh-other",
      }),
    );
    const workB = coordinator.refreshAccountToken(
      b.id,
      credentialGeneration(b),
    );
    const pendingB = await http.next();
    expect(pendingB.credential).toBe("other");
    pendingB.response.resolve(rotated("other-next"));
    expect((await workB).ok).toBe(true);
    expect((await accountMutations.listAccounts()).map((a) => a.id)).toEqual([
      a.id,
      b.id,
    ]);
    pendingA.response.resolve(rotated());
    expect((await workA).ok).toBe(true);
  });

  it("returns terminal for missing or invalidated accounts without HTTP", async () => {
    expect(await coordinator.refreshAccountToken("absent", "g0")).toEqual({
      ok: false,
      terminal: true,
    });
    const old = await accountMutations.upsertAccountByLogin(connectInput());
    await coordinator.invalidateAccountToken(old.id, credentialGeneration(old));
    expect(
      await coordinator.refreshAccountToken(old.id, credentialGeneration(old)),
    ).toEqual({ ok: false, terminal: true });
    expect(http.requests.length).toBe(0);
  });
});
