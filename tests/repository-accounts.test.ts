import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStorageHarness,
  connectInput,
  deferred,
  json,
  rotated,
} from "./helpers/auth-harness";
import {
  accountMutations,
  type AccountConnectInput,
} from "../src/storage/accounts";
import { createStoragePolicy } from "../src/background/storage-policy";
import { createRefreshCoordinator } from "../src/auth/refresh-coordinator";
import { createInstallationRefreshService } from "../src/background/installation-refresh";
import { createRepositoryAccountService } from "../src/background/repository-accounts";
import {
  REPOSITORY_DISCOVERY_KEY,
  type DiscoveryOwner,
} from "../src/background/repository-discovery-ledger";
import { createDiagnosticsService } from "../src/background/diagnostics";
import { ReviewerFetchRuntimeError } from "../src/runtime/reviewer-fetch";

const owner: DiscoveryOwner = {
  documentId: "content-1",
  lane: "content",
  tabId: 2,
};
const all = [
  {
    id: 1,
    account: { login: "acme", type: "Organization" as const, avatarUrl: null },
    repositorySelection: "all" as const,
    repoSnapshot: null,
  },
];
const pulls = (numbers = [42]) =>
  numbers.map((number) => ({
    number,
    user: { login: "author" },
    requested_reviewers: [{ login: "alice" }],
    requested_teams: [],
  }));
const signal = () => new AbortController().signal;
let storage: ReturnType<typeof createStorageHarness>;
let session: ReturnType<typeof createStorageHarness>;
let ready: ReturnType<typeof createStoragePolicy>;
let coordinator: ReturnType<typeof createRefreshCoordinator>;
let service: ReturnType<typeof createRepositoryAccountService>;
let alive: boolean;
const services: Array<typeof service> = [];
function createService() {
  const value = createRepositoryAccountService({
    ensureReady: ready,
    coordinator,
    installations: createInstallationRefreshService({
      refreshCoordinator: coordinator,
    }),
    isOwnerAlive: async () => alive,
  });
  services.push(value);
  return value;
}
async function add(id: string, overrides: Partial<AccountConnectInput> = {}) {
  return accountMutations.upsertAccountByLogin(
    connectInput({
      newAccountId: id,
      login: `user-${id}`,
      token: `fixture-access-${id}`,
      refreshToken: `fixture-refresh-${id}`,
      installations: all,
      now: id.charCodeAt(0),
      ...overrides,
    }),
  );
}
function begin(generation = 0, repo = "private-b", document = owner) {
  return service.begin(document, {
    pageSession: "page",
    generation,
    owner: "acme",
    repo,
  });
}
function mockHttp(
  respond: (
    account: string,
    path: string,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
) {
  const calls: Array<{
    account: string;
    path: string;
    signal: AbortSignal | null | undefined;
  }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const account =
      new Headers(init?.headers)
        .get("Authorization")
        ?.replace("Bearer fixture-access-", "") ?? "anonymous";
    calls.push({ account, path, signal: init?.signal });
    return respond(account, path, init);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}
async function failure(work: Promise<unknown>) {
  const result = await work.catch((error: unknown) => error);
  expect(result).toBeInstanceOf(ReviewerFetchRuntimeError);
  return result as ReviewerFetchRuntimeError;
}
beforeEach(async () => {
  storage = createStorageHarness();
  session = createStorageHarness();
  alive = true;
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("browser", {
    storage: {
      local: { ...storage.local, setAccessLevel: vi.fn(async () => {}) },
      session: { ...session.local, setAccessLevel: vi.fn(async () => {}) },
    },
  });
  ready = createStoragePolicy();
  await ready();
  coordinator = createRefreshCoordinator({
    getClientId: () => "fixture-client",
  });
  service = createService();
});
afterEach(() => {
  for (const value of services.splice(0)) value.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("production repository account service", () => {
  it.each([403, 404])(
    "shares serial A %s → B denial → C success across metadata and rows",
    async (status) => {
      await add("A");
      await add("B");
      await add("C");
      const gate = deferred<Response>();
      const entered = deferred<void>();
      const http = mockHttp((account, path) => {
        if (path.endsWith("/pulls") && account === "A") {
          entered.resolve();
          return gate.promise;
        }
        if (path.endsWith("/pulls") && account === "B") return json({}, status);
        return json(path.endsWith("/pulls") ? pulls([42, 43, 44, 45, 46]) : []);
      });
      const discovery = await begin();
      const metadata = service.metadata(owner, discovery, signal());
      const rows = [42, 43, 44, 45, 46].map((number) =>
        service.summary(owner, discovery, {
          pullNumber: String(number),
          signal: signal(),
        }),
      );
      await entered.promise;
      expect(http.calls.map((call) => call.account)).toEqual(["A"]);
      gate.resolve(json({}, status));
      expect((await metadata).account?.id).toBe("C");
      for (const row of await Promise.all(rows))
        expect(row.account?.id).toBe("C");
      expect(
        http.calls
          .filter((call) => call.path.endsWith("/pulls"))
          .map((call) => call.account),
      ).toEqual(["A", "B", "C"]);
      await service.metadata(owner, discovery, signal());
      expect(
        http.calls.filter((call) => call.path.endsWith("/pulls")),
      ).toHaveLength(3);
    },
  );

  it.each(["A", "B"])(
    "preserves initial stored order when %s was connected first",
    async (first) => {
      const second = first === "A" ? "B" : "A";
      await add(first, { now: 1 });
      await add(second, { now: 2 });
      const http = mockHttp((account) =>
        json(account === first ? {} : pulls(), account === first ? 404 : 200),
      );
      const result = await service.metadata(owner, await begin(), signal());
      expect(result.account?.id).toBe(second);
      expect(http.calls.map((call) => call.account)).toEqual([first, second]);
    },
  );

  it.each([
    [429, {}, {}],
    [403, {}, { "X-RateLimit-Remaining": "0" }],
    [403, { message: "You have exceeded a secondary rate limit" }, {}],
    [500, {}, {}],
    [502, {}, {}],
    [200, { invalid: "schema" }, {}],
  ])(
    "stops on HTTP/schema evidence %s %j %j",
    async (status, body, headers) => {
      await add("A");
      await add("B");
      const http = mockHttp(
        () => new Response(JSON.stringify(body), { status, headers }),
      );
      const discovery = await begin();
      const result = await failure(
        service.metadata(owner, discovery, signal()),
      );
      expect(result.envelope.failures).not.toHaveLength(0);
      await failure(service.metadata(owner, discovery, signal()));
      expect(http.calls.map((call) => call.account)).toEqual(["A"]);
    },
  );

  it("stops on network failure without cycling, including worker restoration", async () => {
    await add("A");
    await add("B");
    const http = mockHttp(() => {
      throw new TypeError("fixture network failure");
    });
    const discovery = await begin();
    await failure(service.metadata(owner, discovery, signal()));
    service.dispose();
    service = createService();
    await failure(service.metadata(owner, discovery, signal()));
    expect(http.calls).toHaveLength(1);
  });

  it.each(["stop", "exhausted", "interrupted"])(
    "retains %s across worker recreation and allows only an explicit new generation",
    async (outcome) => {
      await add("A");
      await add("B");
      const entered = deferred<void>();
      const held = deferred<Response>();
      const http = mockHttp(() => {
        if (outcome === "interrupted") {
          entered.resolve();
          return held.promise;
        }
        return json({}, outcome === "stop" ? 429 : 404);
      });
      const discovery = await begin();
      const first = failure(service.metadata(owner, discovery, signal()));
      if (outcome === "interrupted") {
        await entered.promise;
        service.dispose();
        await first;
      } else {
        await first;
        service.dispose();
      }
      const count = http.calls.length;
      service = createService();
      await failure(service.metadata(owner, discovery, signal()));
      expect(http.calls).toHaveLength(count);
      const newer = await begin(1);
      mockHttp(() => json([]));
      expect((await service.metadata(owner, newer, signal())).account?.id).toBe(
        "A",
      );
      held.resolve(json(pulls()));
    },
  );

  it("resumes a persisted confirmed denial with B after worker recreation", async () => {
    await add("A");
    await add("B");
    const original = session.local.set.getMockImplementation()!;
    session.local.set.mockImplementation(async (values) => {
      await original(values);
      if (JSON.stringify(values).includes('"status":"denied"'))
        service.dispose();
    });
    const http = mockHttp((account) =>
      json(account === "A" ? {} : pulls(), account === "A" ? 404 : 200),
    );
    const discovery = await begin();
    await failure(service.metadata(owner, discovery, signal()));
    session.local.set.mockImplementation(original);
    service = createService();
    expect(
      (await service.metadata(owner, discovery, signal())).account?.id,
    ).toBe("B");
    expect(http.calls.map((call) => call.account)).toEqual(["A", "B"]);
  });

  it.each([0, 1])(
    "canceling joined caller %s preserves the other subscriber",
    async (index) => {
      await add("A");
      await add("B");
      const entered = deferred<void>();
      const held = deferred<Response>();
      const http = mockHttp((account) => {
        if (account === "A") {
          entered.resolve();
          return held.promise;
        }
        return json(pulls());
      });
      const discovery = await begin();
      const controllers = [new AbortController(), new AbortController()];
      const work = controllers.map((controller) =>
        service
          .metadata(owner, discovery, controller.signal)
          .catch((error: unknown) => error),
      );
      await entered.promise;
      controllers[index].abort();
      expect(http.calls[0].signal?.aborted).toBe(false);
      held.resolve(json({}, 404));
      expect(await work[index]).toMatchObject({ name: "AbortError" });
      expect(await work[1 - index]).toMatchObject({ account: { id: "B" } });
      expect(http.calls.map((call) => call.account)).toEqual(["A", "B"]);
    },
  );

  it.each(["last-consumer", "generation", "owner-loss"])(
    "%s aborts HTTP, settles subscribers, and never dispatches B",
    async (mode) => {
      await add("A");
      await add("B");
      const entered = deferred<void>();
      const held = deferred<Response>();
      const http = mockHttp(() => {
        entered.resolve();
        return held.promise;
      });
      const discovery = await begin();
      const controller = new AbortController();
      const work = service
        .metadata(owner, discovery, controller.signal)
        .catch((error: unknown) => error);
      await entered.promise;
      if (mode === "last-consumer") controller.abort();
      else if (mode === "generation") await begin(1);
      else {
        alive = false;
        await service.prune();
      }
      expect(http.calls[0].signal?.aborted).toBe(true);
      expect(await work).toBeInstanceOf(Error);
      held.resolve(json({}, 404));
      await Promise.resolve();
      expect(http.calls.map((call) => call.account)).toEqual(["A"]);
      await failure(service.metadata(owner, discovery, signal()));
      expect(http.calls).toHaveLength(1);
    },
  );

  it.each(["A", null])(
    "terminal replay retains actual account %s, including explicit anonymous null",
    async (accountId) => {
      if (accountId) await add(accountId);
      const entered = deferred<void>();
      const held = deferred<Response>();
      const http = mockHttp(() => {
        entered.resolve();
        return held.promise;
      });
      const discovery = await begin();
      const controller = new AbortController();
      const work = service
        .metadata(owner, discovery, controller.signal)
        .catch((error: unknown) => error);
      await entered.promise;
      controller.abort();
      expect(await work).toMatchObject({ name: "AbortError" });
      // Settle the shared operation, then exercise the same-worker terminal
      // replay independently of its last caller's cancellation response.
      await failure(service.metadata(owner, discovery, signal()));
      const sameWorker = await failure(
        service.metadata(owner, discovery, signal()),
      );
      service.dispose();
      service = createService();
      const restored = await failure(
        service.metadata(owner, discovery, signal()),
      );
      if (accountId) {
        expect(restored.account?.id).toBe(accountId);
        expect(sameWorker.account?.id).toBe(accountId);
      } else {
        expect(restored.account).toBeNull();
        expect(sameWorker.account).toBeNull();
      }
      expect(sameWorker.envelope).toEqual(restored.envelope);
      expect(http.calls).toHaveLength(1);
      held.resolve(json({}, 404));
    },
  );

  it("does not refresh the budget when the ledger body is missing or explicitly retired", async () => {
    await add("A");
    const http = mockHttp(() => json({}, 404));
    const discovery = await begin();
    await failure(service.metadata(owner, discovery, signal()));
    service.dispose();
    const state = session.snapshot()[REPOSITORY_DISCOVERY_KEY] as {
      records: Record<string, unknown>;
    };
    delete state.records[discovery.id];
    await session.local.set({ [REPOSITORY_DISCOVERY_KEY]: state });
    service = createService();
    expect(await begin()).toEqual(discovery);
    await failure(service.metadata(owner, discovery, signal()));
    await service.retire(owner, discovery.id);
    await expect(begin()).rejects.toThrow("retired");
    expect(http.calls).toHaveLength(1);
  });

  it.each(["remove", "reauthenticate", "coverage"])(
    "rejects %s committed after admission but before HTTP",
    async (change) => {
      await add("A");
      await add("B");
      const http = mockHttp(() => json(pulls()));
      const discovery = await begin();
      const barrier = session.pauseSet();
      const work = failure(service.metadata(owner, discovery, signal()));
      await barrier.entered.promise;
      if (change === "remove") await accountMutations.removeAccount("A");
      else
        await add(
          "A",
          change === "coverage"
            ? { installations: [] }
            : {
                token: "fixture-access-new",
                refreshToken: "fixture-refresh-new",
                connectionAttemptId: "reauthentication",
              },
        );
      barrier.release.resolve();
      await work;
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each(["remove", "reauthenticate", "coverage"])(
    "rejects late HTTP after %s even without a notification",
    async (change) => {
      await add("A");
      await add("B");
      const held = deferred<Response>();
      const entered = deferred<void>();
      const http = mockHttp(() => {
        entered.resolve();
        return held.promise;
      });
      const discovery = await begin();
      const work = failure(service.metadata(owner, discovery, signal()));
      await entered.promise;
      if (change === "remove") await accountMutations.removeAccount("A");
      else
        await add(
          "A",
          change === "coverage"
            ? { installations: [] }
            : {
                token: "fixture-access-new",
                connectionAttemptId: "reauthentication",
              },
        );
      held.resolve(json(pulls()));
      await work;
      expect(http.calls).toHaveLength(1);
      await failure(service.metadata(owner, discovery, signal()));
      expect(http.calls).toHaveLength(1);
    },
  );

  it("keeps internal same-account 401 rotation inside one admission then follows a distinct 404 to B", async () => {
    await add("A");
    await add("B");
    const http = mockHttp((account, path) => {
      if (path === "/login/oauth/access_token") return rotated("A-rotated");
      if (account === "A") return json({}, 401);
      return json(
        account === "A-rotated" ? {} : pulls(),
        account === "A-rotated" ? 404 : 200,
      );
    });
    const discovery = await begin();
    const result = await service.metadata(owner, discovery, signal());
    expect(result.account?.id).toBe("B");
    expect(
      http.calls
        .filter((call) => call.path.endsWith("/pulls"))
        .map((call) => call.account),
    ).toEqual(["A", "A-rotated", "B"]);
    expect(
      (await service.ledger.read(owner, discovery.id)).attempts.map(
        (attempt) => attempt.accountId,
      ),
    ).toEqual(["A", "B"]);
  });

  it("unresolved 401 never cycles", async () => {
    await add("A");
    await add("B");
    const http = mockHttp((_account, path) =>
      path === "/login/oauth/access_token" ? rotated("rotated") : json({}, 401),
    );
    await failure(service.metadata(owner, await begin(), signal()));
    expect(http.calls.some((call) => call.account === "B")).toBe(false);
  });

  it("does not share B's success with a different repository or document", async () => {
    await add("A");
    await add("B");
    const http = mockHttp((account, path) =>
      json(
        path.includes("private-b") && account === "A" ? {} : pulls(),
        path.includes("private-b") && account === "A" ? 404 : 200,
      ),
    );
    expect(
      (await service.metadata(owner, await begin(), signal())).account?.id,
    ).toBe("B");
    expect(
      (await service.metadata(owner, await begin(1, "private-a"), signal()))
        .account?.id,
    ).toBe("A");
    const other = { ...owner, documentId: "content-2" };
    expect(
      (
        await service.metadata(
          other,
          await begin(0, "private-a", other),
          signal(),
        )
      ).account?.id,
    ).toBe("A");
    expect(http.calls.map((call) => call.account)).toEqual([
      "A",
      "B",
      "A",
      "A",
    ]);
  });

  it("a PR-only 404 under accessible A is row-local; a different PR still renders with A", async () => {
    await add("A");
    await add("B");
    const http = mockHttp((_account, path) =>
      json(
        path.endsWith("/pulls") ? pulls([43]) : path.includes("/42") ? {} : [],
        path.includes("/42") ? 404 : 200,
      ),
    );
    const discovery = await begin();
    await failure(
      service.summary(owner, discovery, { pullNumber: "42", signal: signal() }),
    );
    expect(
      (
        await service.summary(owner, discovery, {
          pullNumber: "43",
          signal: signal(),
        })
      ).account?.id,
    ).toBe("A");
    expect(http.calls.some((call) => call.account === "B")).toBe(false);
    expect((await service.ledger.read(owner, discovery.id)).status).toBe(
      "success",
    );
  });

  it("matched diagnostics uses B, preserves no-pulls, retries on a new run, and leaves no-token anonymous", async () => {
    await add("A");
    await add("B");
    const http = mockHttp((account) =>
      json(account === "A" ? {} : [], account === "A" ? 404 : 200),
    );
    const diagnose = createDiagnosticsService(coordinator, service);
    const run = {
      owner: { documentId: "options", lane: "diagnostic" as const },
      signal: signal(),
      runId: "run-1",
      generation: 0,
    };
    expect(await diagnose("acme", "private-b", "matched", run)).toMatchObject({
      kind: "matched",
      account: { login: "user-B" },
      result: { outcome: "no-pulls" },
    });
    expect(
      await diagnose("acme", "private-b", "matched", {
        ...run,
        runId: "run-2",
        generation: 1,
      }),
    ).toMatchObject({ account: { login: "user-B" } });
    expect(
      await diagnose("acme", "private-b", "no-token", {
        ...run,
        runId: "run-3",
        generation: 2,
      }),
    ).toMatchObject({ kind: "no-token", result: { outcome: "no-pulls" } });
    expect(http.calls.map((call) => call.account)).toEqual([
      "A",
      "B",
      "A",
      "B",
      "anonymous",
    ]);
  });

  it("diagnostic cancellation cannot stop content discovery", async () => {
    await add("A");
    const held = [deferred<Response>(), deferred<Response>()];
    let index = 0;
    const entered = deferred<void>();
    const pageEntered = deferred<void>();
    const http = mockHttp(() => {
      const response = held[index++];
      if (index === 1) pageEntered.resolve();
      if (index === 2) entered.resolve();
      return response.promise;
    });
    const page = service.metadata(owner, await begin(), signal());
    await pageEntered.promise;
    const diagnosticOwner = {
      documentId: "options",
      lane: "diagnostic" as const,
    };
    const controller = new AbortController();
    const diagnostic = service
      .metadata(
        diagnosticOwner,
        await begin(0, "private-b", diagnosticOwner),
        controller.signal,
      )
      .catch((error: unknown) => error);
    await entered.promise;
    controller.abort();
    expect(http.calls[0].signal?.aborted).toBe(false);
    held[0].resolve(json(pulls()));
    expect((await page).account?.id).toBe("A");
    expect(await diagnostic).toMatchObject({ name: "AbortError" });
    held[1].resolve(json({}, 404));
  });
});

describe("public compatibility, evidence, and ordinary reuse", () => {
  it("keeps successful no-token metadata and reviewer HTTP anonymous", async () => {
    const http = mockHttp((_account, path) =>
      json(path.endsWith("/pulls") ? pulls() : []),
    );
    const discovery = await begin();
    expect(
      (
        await service.summary(owner, discovery, {
          pullNumber: "42",
          signal: signal(),
        })
      ).account,
    ).toBeNull();
    expect(http.calls.map((call) => call.account)).toEqual([
      "anonymous",
      "anonymous",
    ]);
  });

  it.each([200, 429])(
    "anonymous 429 uses the single unambiguous account; its authenticated %s is final",
    async (status) => {
      await add("A", { installations: [] });
      const http = mockHttp((account, path) =>
        account === "anonymous"
          ? json({}, 429)
          : json(path.endsWith("/pulls") ? pulls() : [], status),
      );
      const discovery = await begin();
      if (status === 200) {
        const row = await service.summary(owner, discovery, {
          pullNumber: "42",
          signal: signal(),
        });
        expect(row.account?.id).toBe("A");
        expect(http.calls.map((call) => call.account)).toEqual([
          "anonymous",
          "A",
          "A",
        ]);
      } else {
        const error = await failure(
          service.summary(owner, discovery, {
            pullNumber: "42",
            signal: signal(),
          }),
        );
        expect(error.envelope.failures?.[0]).toMatchObject({
          status: 429,
          rateLimited: true,
        });
        expect(error.account?.id).toBe("A");
        await failure(service.metadata(owner, discovery, signal()));
        expect(http.calls.map((call) => call.account)).toEqual([
          "anonymous",
          "A",
        ]);
      }
    },
  );

  it("an anonymous row's rate limit shares one unambiguous authenticated probe and keeps the ordinary rows authenticated", async () => {
    await add("A", { installations: [] });
    const http = mockHttp((account, path) =>
      account === "anonymous" && path.endsWith("/reviews")
        ? json({}, 429)
        : json(path.endsWith("/pulls") ? pulls([42, 43, 44]) : []),
    );
    const discovery = await begin();
    const rows = await Promise.all(
      [42, 43, 44].map((number) =>
        service.summary(owner, discovery, {
          pullNumber: String(number),
          signal: signal(),
        }),
      ),
    );
    expect(rows.every((row) => row.account?.id === "A")).toBe(true);
    expect(
      http.calls
        .filter((call) => call.path.endsWith("/pulls"))
        .map((call) => call.account),
    ).toEqual(["anonymous", "A"]);
    expect(
      (await service.ledger.read(owner, discovery.id)).attempts.map(
        (attempt) => attempt.accountId,
      ),
    ).toEqual(["A"]);
  });

  it("an ambiguous anonymous 429 never guesses between connected accounts", async () => {
    await add("A", { installations: [] });
    await add("B", { installations: [] });
    const http = mockHttp(() => json({}, 429));
    const discovery = await begin();
    await failure(service.metadata(owner, discovery, signal()));
    await failure(
      service.summary(owner, discovery, { pullNumber: "42", signal: signal() }),
    );
    expect(http.calls.map((call) => call.account)).toEqual(["anonymous"]);
  });

  it("rechecks covered-before-truncated eligibility, case, duplicates, complete misses, and unrelated accounts using current storage", async () => {
    const selected = (
      completeness: "complete" | "truncated",
      fullNames: string[],
      login = "ACME",
    ) => [
      {
        ...all[0],
        account: { ...all[0].account, login },
        repositorySelection: "selected" as const,
        repoSnapshot: { completeness, fullNames },
      },
    ];
    await add("A");
    await add("B", { installations: selected("truncated", []) });
    await add("C", {
      installations: [...selected("complete", ["AcMe/PrIvAtE-B"]), ...all],
    });
    await add("D", { installations: selected("complete", ["acme/other"]) });
    await add("E", {
      installations: [
        { ...all[0], account: { ...all[0].account, login: "unrelated" } },
      ],
    });
    const http = mockHttp((account) =>
      json(account === "B" ? pulls() : {}, account === "B" ? 200 : 404),
    );
    expect(
      (await service.metadata(owner, await begin(), signal())).account?.id,
    ).toBe("B");
    expect(http.calls.map((call) => call.account)).toEqual(["A", "C", "B"]);
  });

  it.each(["remove", "invalidate"])(
    "does not dispatch to an unattempted account after %s",
    async (change) => {
      await add("A");
      const b = await add("B");
      await add("C");
      const entered = deferred<void>();
      const held = deferred<Response>();
      const http = mockHttp((account) => {
        if (account === "A") {
          entered.resolve();
          return held.promise;
        }
        return json(pulls());
      });
      const work = service.metadata(owner, await begin(), signal());
      await entered.promise;
      if (change === "remove") await accountMutations.removeAccount("B");
      else
        await accountMutations.commitAuth(
          "B",
          b.credentialGeneration ?? "legacy",
          { invalidatedReason: "revoked" },
        );
      held.resolve(json({}, 404));
      expect((await work).account?.id).toBe("C");
      expect(http.calls.map((call) => call.account)).toEqual(["A", "C"]);
    },
  );

  it("the existing bounded installation self-heal can supply fresh selected coverage before discovery", async () => {
    await add("A", {
      installations: [
        {
          ...all[0],
          repositorySelection: "selected",
          repoSnapshot: { fullNames: ["acme/old"], completeness: "complete" },
        },
      ],
    });
    const http = mockHttp((_account, path) => {
      if (path === "/user/installations")
        return json({
          total_count: 1,
          installations: [
            {
              id: 1,
              account: {
                login: "acme",
                type: "Organization",
                avatar_url: null,
              },
              repository_selection: "selected",
            },
          ],
        });
      if (path === "/user/installations/1/repositories")
        return json({
          total_count: 1,
          repositories: [{ full_name: "acme/private-b" }],
        });
      return json(pulls());
    });
    const discovery = await begin();
    expect(
      (await service.metadata(owner, discovery, signal())).account?.id,
    ).toBe("A");
    await service.metadata(owner, discovery, signal());
    expect(http.calls.map((call) => call.path)).toEqual([
      "/user/installations",
      "/user/installations/1/repositories",
      "/repos/acme/private-b/pulls",
    ]);
  });

  it("a refreshed selected snapshot becomes eligible while earlier denial is pending", async () => {
    await add("A");
    const b = await add("B", {
      installations: [
        {
          ...all[0],
          repositorySelection: "selected",
          repoSnapshot: { fullNames: ["acme/old"], completeness: "complete" },
        },
      ],
    });
    const entered = deferred<void>();
    const held = deferred<Response>();
    const http = mockHttp((account) => {
      if (account === "A") {
        entered.resolve();
        return held.promise;
      }
      return json(pulls());
    });
    const work = service.metadata(owner, await begin(), signal());
    await entered.promise;
    await accountMutations.replaceInstallations(
      "B",
      [
        {
          ...all[0],
          repositorySelection: "selected",
          repoSnapshot: {
            fullNames: ["acme/private-b"],
            completeness: "complete",
          },
        },
      ],
      b.credentialGeneration ?? "legacy",
    );
    held.resolve(json({}, 404));
    expect((await work).account?.id).toBe("B");
    expect(http.calls.map((call) => call.account)).toEqual(["A", "B"]);
  });

  it("a successful account later denied by ordinary metadata only uses remaining candidates and cannot restart at A", async () => {
    await add("A");
    await add("B");
    await add("C");
    let bWorked = false;
    const http = mockHttp((account) => {
      if (account === "A" || (account === "B" && bWorked)) return json({}, 404);
      if (account === "B") bWorked = true;
      return json(pulls());
    });
    const discovery = await begin();
    expect(
      (await service.metadata(owner, discovery, signal())).account?.id,
    ).toBe("B");
    const time = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(time + 10_001);
    expect(
      (await service.metadata(owner, discovery, signal())).account?.id,
    ).toBe("C");
    expect(http.calls.map((call) => call.account)).toEqual([
      "A",
      "B",
      "B",
      "C",
    ]);
    expect(
      (await service.ledger.read(owner, discovery.id)).attempts.map(
        (attempt) => attempt.accountId,
      ),
    ).toEqual(["A", "B", "C"]);
  });

  it("never sends HTTP when trusted-session admission cannot be saved", async () => {
    await add("A");
    const http = mockHttp(() => json(pulls()));
    const discovery = await begin();
    session.local.set.mockRejectedValue(
      new Error("fixture unavailable session"),
    );
    await failure(service.metadata(owner, discovery, signal()));
    expect(http.calls).toHaveLength(0);
  });

  it.each([429, 401, 500, "network", "schema"])(
    "preserves a full 404 + %s row envelope and does not cycle",
    async (other) => {
      await add("A", { refreshToken: null });
      await add("B");
      const http = mockHttp((_account, path) => {
        if (path.endsWith("/pulls")) return json(pulls([43]));
        if (!path.endsWith("/reviews")) return json({}, 404);
        if (other === "network") throw new TypeError("fixture network");
        return json(
          other === "schema" ? {} : {},
          typeof other === "number" ? other : 200,
        );
      });
      const discovery = await begin();
      const error = await failure(
        service.summary(owner, discovery, {
          pullNumber: "42",
          signal: signal(),
        }),
      );
      expect(error.envelope.failures).toHaveLength(2);
      expect(
        error.envelope.failures?.map((failure) => failure.status),
      ).toContain(404);
      expect(
        error.envelope.failures?.some(
          (failure) => failure.status === other || failure.kind === other,
        ),
      ).toBe(true);
      expect(http.calls.some((call) => call.account === "B")).toBe(false);
    },
  );
});

it.each([429, 401, 500, "network", "schema"])(
  "matched diagnostics retains PR 404 plus %s after repository success, without cycling",
  async (other) => {
    await add("A");
    await add("B");
    const http = mockHttp((_account, path) => {
      if (path.endsWith("/pulls")) return json(pulls());
      if (path.endsWith("/reviews")) {
        if (other === "network")
          throw new TypeError("synthetic transport error");
        return json(
          other === "schema" ? {} : {},
          typeof other === "number" ? other : 200,
        );
      }
      return json({}, 404);
    });
    const diagnose = createDiagnosticsService(coordinator, service);
    const result = await diagnose("acme", "private-b", "matched", {
      owner: { documentId: "options", lane: "diagnostic" },
      signal: signal(),
      runId: "mixed-evidence",
      generation: 1,
    });
    expect(result).toMatchObject({
      kind: "matched",
      account: { login: "user-A" },
      result: {
        ok: false,
        pullNumber: "42",
        outcome:
          other === 429
            ? "authenticated-rate-limit"
            : other === 401
              ? "token-invalid"
              : "unknown-error",
      },
    });
    if (result.kind !== "matched") throw new Error("missing diagnostic result");
    expect(result.result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ httpStatus: 404 }),
        expect.objectContaining(
          typeof other === "number" ? { httpStatus: other } : { kind: other },
        ),
      ]),
    );
    expect(http.calls.some((call) => call.account === "B")).toBe(false);
  },
);

describe("shared repository metadata deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the original 30s across subscribers and stops admission without invalidation", async () => {
    vi.useFakeTimers();
    await add("A");
    await add("B");
    const gate = deferred<Response>();
    const entered = deferred<void>();
    const http = mockHttp(() => {
      entered.resolve();
      return gate.promise;
    });
    const discovery = await begin();
    const firstSignal = new AbortController();
    const first = service
      .metadata(owner, discovery, firstSignal.signal)
      .catch((error: unknown) => error);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    const second = service
      .metadata(owner, discovery, signal())
      .catch((error: unknown) => error);
    firstSignal.abort();
    expect(await first).toMatchObject({ name: "AbortError" });
    expect(http.calls[0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await second).toMatchObject({
      envelope: {
        status: null,
        failures: [{ kind: "timeout" }],
        discoveryOutcome: "unavailable",
      },
    });
    expect(http.calls[0].signal?.aborted).toBe(true);
    const record = await service.ledger.read(owner, discovery.id);
    expect(record.status).toBe("stopped");
    expect(record.attempts.map((attempt) => attempt.accountId)).toEqual(["A"]);
    for (const id of ["A", "B"])
      expect((await accountMutations.getAccountById(id))?.invalidated).toBe(
        false,
      );
    gate.resolve(json(pulls()));
    await vi.advanceTimersByTimeAsync(0);
    const again = await failure(service.metadata(owner, discovery, signal()));
    expect(again.envelope.failures?.[0].kind).toBe("timeout");
    expect(http.calls.map((call) => call.account)).toEqual(["A"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates every shared metadata subscriber without duplicate HTTP", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    const http = mockHttp(() => {
      entered.resolve();
      return new Promise(() => {});
    });
    const discovery = await begin();
    const consumers = Array.from({ length: 8 }, () =>
      service
        .metadata(owner, discovery, signal())
        .catch((error: unknown) => error),
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    for (const result of await Promise.all(consumers))
      expect(result).toMatchObject({
        envelope: { failures: [{ kind: "timeout" }] },
      });
    expect(http.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets another consumer finish just before timeout after one cancels", async () => {
    vi.useFakeTimers();
    const gate = deferred<Response>();
    const entered = deferred<void>();
    const http = mockHttp(() => {
      entered.resolve();
      return gate.promise;
    });
    const discovery = await begin();
    const controller = new AbortController();
    const first = service
      .metadata(owner, discovery, controller.signal)
      .catch((error: unknown) => error);
    const second = service.metadata(owner, discovery, signal());
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    controller.abort();
    expect(await first).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(9_999);
    gate.resolve(json(pulls()));
    expect((await second).metadata?.[0].number).toBe("42");
    await vi.advanceTimersByTimeAsync(1);
    expect(http.calls[0].signal?.aborted).toBe(false);
    expect(http.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels HTTP on last detach and prevents late metadata in a new generation", async () => {
    vi.useFakeTimers();
    const gate = deferred<Response>();
    const entered = deferred<void>();
    let count = 0;
    const http = mockHttp(() => {
      if (++count === 1) {
        entered.resolve();
        return gate.promise;
      }
      return json(pulls([43]));
    });
    const discovery = await begin();
    const controller = new AbortController();
    const first = service
      .metadata(owner, discovery, controller.signal)
      .catch((error: unknown) => error);
    await entered.promise;
    controller.abort();
    expect(await first).toMatchObject({ name: "AbortError" });
    expect(http.calls[0].signal?.aborted).toBe(true);
    await service.retire(owner, discovery.id);
    const next = await begin(1);
    expect(
      (await service.metadata(owner, next, signal())).metadata?.[0].number,
    ).toBe("43");
    gate.resolve(json(pulls([42])));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      (await service.metadata(owner, next, signal())).metadata?.[0].number,
    ).toBe("43");
    expect(http.calls).toHaveLength(3); // Existing metadata freshness expires at 10s; no old-generation write.
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("expires a production summary's refresh waiter without retiring successful discovery or invalidating accounts", async () => {
  vi.useFakeTimers();
  try {
    await add("A");
    await add("B");
    const gate = deferred<{ ok: true; generation: string }>();
    const entered = deferred<void>();
    vi.spyOn(coordinator, "refreshAccountToken").mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });
    const invalidate = vi.spyOn(coordinator, "invalidateAccountToken");
    const http = mockHttp((_account, path) =>
      json(
        path.endsWith("/pulls") ? pulls() : {},
        path.endsWith("/pulls") ? 200 : 401,
      ),
    );
    const discovery = await begin();
    await service.metadata(owner, discovery, signal());
    const work = service
      .summary(owner, discovery, { pullNumber: "42", signal: signal() })
      .catch((error: unknown) => error);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await work).toMatchObject({
      envelope: { status: null, failures: [{ kind: "timeout" }] },
    });
    expect((await service.ledger.read(owner, discovery.id)).status).toBe(
      "success",
    );
    gate.resolve({ ok: true, generation: "late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidate).not.toHaveBeenCalled();
    expect(http.calls.map((call) => call.account)).toEqual(["A", "A"]);
    expect((await accountMutations.getAccountById("A"))?.invalidated).toBe(
      false,
    );
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
