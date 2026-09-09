import { describe, expect, it } from "vitest";

import {
  classifyRepositoryFailure,
  orderRepositoryCandidates,
  type RepositoryAccountFact,
  type RepositoryFailureFact,
  type RepositoryInstallationFact,
} from "../src/background/repository-account-policy";

// Exercise the pure policy separately from real service/bridge tests.
const all = (owner = "acme"): RepositoryInstallationFact => ({
  owner,
  selection: "all",
});
const selected = (
  repositoryFullNames: string[] = [],
  truncated = false,
  owner = "acme",
): RepositoryInstallationFact => ({
  owner,
  selection: "selected",
  repositoryFullNames,
  truncated,
});
const account = (
  accountId: string,
  installations: readonly RepositoryInstallationFact[] = [all()],
  overrides: Partial<RepositoryAccountFact> = {},
): RepositoryAccountFact => ({
  accountId,
  active: true,
  present: true,
  installations,
  ...overrides,
});
const candidates = (
  accounts: readonly RepositoryAccountFact[],
  attemptedAccountIds: readonly string[] = [],
  owner = "acme",
  repo = "private-b",
) =>
  orderRepositoryCandidates({
    owner,
    repo,
    accounts,
    attemptedAccountIds,
  });
const failure = (
  status: number | null,
  overrides: Partial<RepositoryFailureFact> = {},
): RepositoryFailureFact => ({
  kind: "http",
  status,
  scope: "repository",
  ...overrides,
});
const classify = (failures: readonly RepositoryFailureFact[]) =>
  classifyRepositoryFailure({ authenticated: true, failures });

describe("repository candidate policy", () => {
  it.each([
    ["A", "B"],
    ["B", "A"],
  ])("preserves current stored order %s, %s within a tier", (first, second) => {
    expect(candidates([account(first), account(second)])).toEqual([
      { accountId: first, tier: "covered" },
      { accountId: second, tier: "covered" },
    ]);
  });

  it("places covered accounts before truncated ones, retaining each tier's order", () => {
    expect(
      candidates([
        account("C", [selected([], true)]),
        account("B", [selected(["acme/private-b"])]),
        account("D", [selected(["acme/other"], true)]),
        account("A"),
        account("E", [selected(["acme/private-b"], true)]),
      ]),
    ).toEqual([
      { accountId: "B", tier: "covered" },
      { accountId: "A", tier: "covered" },
      { accountId: "E", tier: "covered" },
      { accountId: "C", tier: "truncated" },
      { accountId: "D", tier: "truncated" },
    ]);
  });

  it("matches owner and repository case-insensitively, keeping account IDs opaque", () => {
    expect(
      candidates(
        [
          account("A", [all("AcMe")]),
          account("a", [selected(["ACME/PRIVATE-B"], false, "aCmE")]),
        ],
        ["A"],
        "ACME",
        "Private-B",
      ),
    ).toEqual([{ accountId: "a", tier: "covered" }]);
  });

  it("deduplicates installations and IDs, placing mixed coverage in the covered tier once", () => {
    const mixed = account("A", [selected([], true), all(), all()]);
    expect(
      candidates([account("B", [selected([], true)]), mixed, mixed]),
    ).toEqual([
      { accountId: "A", tier: "covered" },
      { accountId: "B", tier: "truncated" },
    ]);
  });

  it("excludes previously attempted accounts, including the initial account", () => {
    const accounts = [account("A"), account("B"), account("C")];
    expect(candidates(accounts, ["A", "B", "A"])).toEqual([
      { accountId: "C", tier: "covered" },
    ]);
    expect(candidates(accounts, ["A", "B", "C"])).toEqual([]);
  });

  it("excludes missing, invalidated, unrelated, and unsupported accounts", () => {
    expect(
      candidates([
        account("removed", [all()], { present: false }),
        account("invalidated", [all()], { active: false }),
        account("unrelated", [all("other")]),
        account("acme", []),
        account("wrong-installation", [
          selected(["acme/private-b"], true, "other"),
        ]),
        account("valid"),
      ]),
    ).toEqual([{ accountId: "valid", tier: "covered" }]);
  });

  it("never infers eligibility from one global account or an owner-like account ID", () => {
    expect(candidates([account("acme", [])])).toEqual([]);
    expect(candidates([account("only", [all("other")])])).toEqual([]);
    expect(candidates([])).toEqual([]);
  });

  it("does not let a duplicate record resurrect an unavailable first record", () => {
    expect(
      candidates([account("A", [all()], { active: false }), account("A")]),
    ).toEqual([]);
  });

  it("excludes complete selected misses until new installation facts establish eligibility", () => {
    const before = account("A", [selected(["acme/other"])]);
    expect(candidates([before])).toEqual([]);
    expect(candidates([account("A", [selected(["acme/private-b"])])])).toEqual([
      { accountId: "A", tier: "covered" },
    ]);
    expect(candidates([account("A", [selected([], true)])])).toEqual([
      { accountId: "A", tier: "truncated" },
    ]);
    // Service tests separately exercise the actual bounded refresh path.
    expect(candidates([before])).toEqual([]);
  });

  it("does not broaden exact repository coverage to another repository under the owner", () => {
    const accounts = [account("A", [selected(["acme/private-b-extra"])])];
    expect(candidates(accounts)).toEqual([]);
    expect(candidates(accounts, [], "acme", "private-b-extra")).toEqual([
      { accountId: "A", tier: "covered" },
    ]);
  });

  it("reevaluates removal and invalidation without changing caller-owned attempt facts", () => {
    const attempts = Object.freeze(["A"]);
    const accounts = Object.freeze([
      Object.freeze(account("B", Object.freeze([all()]))),
      account("C"),
    ]);
    expect(
      candidates(accounts, attempts).map((item) => item.accountId),
    ).toEqual(["B", "C"]);
    expect(
      candidates(
        [
          { ...accounts[0], present: false },
          { ...accounts[1], active: false },
        ],
        attempts,
      ),
    ).toEqual([]);
    expect(attempts).toEqual(["A"]);
    expect(accounts[0].present).toBe(true);
  });
});

describe("authenticated failure policy", () => {
  it.each([403, 404])(
    "accepts a non-rate-limited repository HTTP %s denial",
    (status) => {
      expect(classify([failure(status)])).toEqual({
        kind: "repository-denial",
      });
    },
  );

  it("accepts only unresolved access denials across the full envelope", () => {
    expect(classify([failure(404), failure(403, { scope: "pull" })])).toEqual({
      kind: "repository-denial",
    });
  });

  const stoppingFacts: Array<[string, RepositoryFailureFact, string]> = [
    ["HTTP 429", failure(429), "rate-limit"],
    [
      "primary exhaustion",
      failure(403, { rateLimitRemaining: 0 }),
      "rate-limit",
    ],
    [
      "secondary limit",
      failure(403, { secondaryRateLimited: true }),
      "rate-limit",
    ],
    [
      "decoded rate-limit signal",
      failure(404, { rateLimited: true }),
      "rate-limit",
    ],
    ["unresolved HTTP 401", failure(401), "authentication"],
    ["network error", failure(null, { kind: "network" }), "non-access-failure"],
    ["schema error", failure(null, { kind: "schema" }), "non-access-failure"],
    [
      "cancellation",
      failure(null, { kind: "cancellation" }),
      "non-access-failure",
    ],
    ["unknown error", failure(null, { kind: "unknown" }), "non-access-failure"],
    ["HTTP 500", failure(500), "non-access-failure"],
    ["HTTP 503", failure(503), "non-access-failure"],
    ["HTTP 422", failure(422), "non-access-failure"],
    ["missing status", failure(null), "non-access-failure"],
    [
      "schema error with 404",
      failure(404, { kind: "schema" }),
      "non-access-failure",
    ],
  ];

  it.each(stoppingFacts)(
    "stops on %s alone and mixed with denials in either order",
    (_label, fact, reason) => {
      for (const facts of [
        [fact],
        [failure(404), fact],
        [fact, failure(403)],
      ]) {
        expect(classify(facts)).toEqual({ kind: "stop", reason });
      }
    },
  );

  it("prioritizes rate-limit evidence even when 401 and other failures coexist", () => {
    const facts = [failure(404), failure(401), failure(429), failure(503)];
    expect(classify(facts)).toEqual({ kind: "stop", reason: "rate-limit" });
    expect(classify([...facts].reverse())).toEqual({
      kind: "stop",
      reason: "rate-limit",
    });
  });

  it("requires distinct new denial facts after a recovered 401; it never authorizes refresh itself", () => {
    expect(classify([failure(401)])).toEqual({
      kind: "stop",
      reason: "authentication",
    });
    expect(classify([failure(401), failure(404)])).toEqual({
      kind: "stop",
      reason: "authentication",
    });
    expect(classify([failure(404)])).toEqual({ kind: "repository-denial" });
  });

  it.each(["pull", "unknown"] as const)(
    "requires repository evidence for %s-only denial",
    (scope) => {
      expect(
        classify([failure(404, { scope }), failure(403, { scope })]),
      ).toEqual({
        kind: "repository-evidence-required",
      });
    },
  );

  it("does not treat an absent failure envelope as a denial or success", () => {
    expect(classify([])).toEqual({ kind: "stop", reason: "missing-evidence" });
  });

  it.each([401, 403, 404, 429])(
    "keeps anonymous HTTP %s outside this policy",
    (status) => {
      expect(
        classifyRepositoryFailure({
          authenticated: false,
          failures: [failure(status)],
        }),
      ).toEqual({
        kind: "stop",
        reason: "anonymous",
      });
    },
  );

  it("leaves immutable failure facts intact for the owner to retain as evidence", () => {
    const facts = Object.freeze([
      Object.freeze(failure(404)),
      Object.freeze(
        failure(403, { rateLimitRemaining: 0, secondaryRateLimited: true }),
      ),
    ]);
    const before = JSON.stringify(facts);
    expect(classify(facts)).toEqual({ kind: "stop", reason: "rate-limit" });
    expect(JSON.stringify(facts)).toBe(before);
  });
});

it("timeout never admits another account or initiates authentication recovery", () => {
  for (const other of [401, 403, 404, 429, 500]) {
    expect(
      classify([failure(other), failure(null, { kind: "timeout" })]),
    ).toEqual({ kind: "stop", reason: "non-access-failure" });
  }
});
