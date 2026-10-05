import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectInput,
  createStorageHarness,
  deferred,
  json,
} from "./helpers/auth-harness";

let storage: ReturnType<typeof createStorageHarness>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const userRequests: string[] = [];

beforeEach(() => {
  vi.resetModules();
  storage = createStorageHarness();
  userRequests.length = 0;
  fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    expect(new URL(String(url)).pathname).toBe("/user");
    const token =
      new Headers(init?.headers)
        .get("Authorization")
        ?.replace(/^Bearer /, "") ?? "";
    userRequests.push(token);
    return json({ id: 42, login: "octocat-renamed", avatar_url: null });
  });
  vi.stubGlobal("browser", { storage: { local: storage.local } });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function seedLegacy(overrides: Parameters<typeof connectInput>[0] = {}) {
  const { accountMutations } = await import("../src/storage/accounts");
  const account = await accountMutations.upsertAccountByLogin(
    connectInput(overrides),
  );
  const key = `account:profile:${account.id}`;
  const profile = storage.snapshot()[key] as Record<string, unknown>;
  delete profile.userId;
  await storage.local.set({ [key]: profile });
  return account;
}

async function service() {
  const { createAccountIdentityBackfill } =
    await import("../src/background/account-identity");
  return createAccountIdentityBackfill();
}

describe("account identity backfill", () => {
  it("stores the user id for a valid account that has none", async () => {
    const legacy = await seedLegacy();

    await (await service()).backfillMissingUserIds();

    const { accountMutations } = await import("../src/storage/accounts");
    expect(await accountMutations.getAccountById(legacy.id)).toMatchObject({
      userId: 42,
      login: "octocat-renamed",
      invalidated: false,
    });
    expect(userRequests).toEqual(["fixture-access-0"]);
  });

  it("does not request /user for keyed or invalidated accounts", async () => {
    const { accountMutations } = await import("../src/storage/accounts");
    await accountMutations.upsertAccountByLogin(connectInput({ userId: 7 }));
    const invalid = await seedLegacy({ login: "gone", newAccountId: "gone" });
    await accountMutations.commitAuth(
      invalid.id,
      invalid.credentialGeneration!,
      { invalidatedReason: "revoked" },
    );

    await (await service()).backfillMissingUserIds();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the account valid and unchanged when /user fails", async () => {
    const legacy = await seedLegacy();
    const before = storage.snapshot();
    fetchMock.mockResolvedValueOnce(json({ message: "unavailable" }, 502));
    const backfill = await service();

    await backfill.backfillMissingUserIds();

    expect(storage.snapshot()).toEqual(before);
    // A later pass retries.
    await backfill.backfillMissingUserIds();
    const { accountMutations } = await import("../src/storage/accounts");
    expect((await accountMutations.getAccountById(legacy.id))?.userId).toBe(42);
  });

  it("joins a pass that is already running", async () => {
    await seedLegacy();
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const backfill = await service();

    const first = backfill.backfillMissingUserIds();
    const second = backfill.backfillMissingUserIds();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    response.resolve(json({ id: 42, login: "octocat", avatar_url: null }));
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not commit a /user response for credentials replaced meanwhile", async () => {
    const legacy = await seedLegacy();
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    const pass = (await service()).backfillMissingUserIds();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { accountMutations } = await import("../src/storage/accounts");
    await accountMutations.commitAuth(legacy.id, legacy.credentialGeneration!, {
      tokens: {
        token: "fixture-access-1",
        refreshToken: "fixture-refresh-1",
        expiresAt: 2,
        refreshTokenExpiresAt: null,
      },
    });

    response.resolve(json({ id: 42, login: "octocat", avatar_url: null }));
    await pass;

    expect(
      (await accountMutations.getAccountById(legacy.id))?.userId,
    ).toBeUndefined();
  });
});
