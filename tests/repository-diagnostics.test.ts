import { describe, expect, it } from "vitest";
import {
  buildMatchedAccountDiagnostic,
  buildNoTokenDiagnostic,
  buildRepositoryDiagnostic,
  buildUncoveredAccountDiagnostic,
} from "../src/features/repository-diagnostics";
import type {
  RepositoryValidationOutcome,
  RepositoryValidationResult,
} from "../src/github/api";
import { createTranslator, type Locale } from "../src/i18n";

const locales: Locale[] = ["en", "ko", "ja", "zh_CN", "zh_TW"];
const outcomes: RepositoryValidationOutcome[] = [
  "accessible",
  "invalid-repository",
  "no-pulls",
  "authenticated-rate-limit",
  "unauthenticated-rate-limit",
  "unauthenticated-private-like",
  "token-invalid",
  "token-permission",
  "token-not-found",
  "unknown-error",
];
const poison = "PRIVATE raw Error.message should never appear";
function result(
  outcome: RepositoryValidationOutcome,
  authMode: "token" | "no-token",
): RepositoryValidationResult {
  return {
    ok: outcome === "accessible",
    outcome,
    authMode,
    message: poison,
    fullName: "Octo/repo-name",
    pullNumber: "42",
  } as RepositoryValidationResult;
}
const rate = {
  limit: 5000,
  remaining: 0,
  resource: "core",
  resetAt: 1710000000,
};

// Every outcome/auth discriminator remains data; translations must not read legacy prose.
describe.each(locales)("repository diagnostics in %s", (locale) => {
  const t = createTranslator(locale);
  it.each(outcomes)(
    "renders %s in both access paths without legacy messages",
    (outcome) => {
      for (const authMode of ["token", "no-token"] as const) {
        const data = result(outcome, authMode);
        const diagnostic =
          authMode === "token"
            ? buildMatchedAccountDiagnostic(
                {
                  repository: "input/original",
                  coverageStatus: "covered",
                  account: { login: "Octocat" },
                  result: data,
                },
                t,
              )
            : buildNoTokenDiagnostic(
                { repository: "input/original", result: data },
                t,
              );
        expect(diagnostic.tone).toBe(
          outcome === "accessible" ? "success" : "error",
        );
        expect(JSON.stringify(diagnostic)).not.toContain(poison);
        expect(diagnostic.message.length).toBeGreaterThan(10);
        expect(diagnostic.fields[0]).toMatchObject({
          label: t("diagnostics_repository"),
          value: "Octo/repo-name",
        });
        expect(diagnostic.fields[2].value).toBe(
          t(
            authMode === "token"
              ? "diagnostics_matched_token"
              : "diagnostics_no_token",
          ),
        );
        if (authMode === "token")
          expect(diagnostic.fields[1].value).toBe("@Octocat");
        if (outcome === "accessible") {
          expect(diagnostic.message).toContain(
            "GET /repos/Octo/repo-name/pulls/42",
          );
          expect(diagnostic.message).toContain(
            "GET /repos/Octo/repo-name/pulls/42/reviews",
          );
        }
        if (locale !== "en") {
          const english = buildNoTokenDiagnostic({
            repository: "input/original",
            result: data,
          });
          expect(diagnostic.message).not.toBe(english.message);
          expect(diagnostic.fields[4].value).not.toBe(english.fields[4].value);
        }
        expect(data.message).toBe(poison);
      }
    },
  );

  it("distinguishes local uncovered/truncated coverage from endpoint evidence", () => {
    const uncovered = buildUncoveredAccountDiagnostic("Octo/repo-name", t);
    expect(uncovered.message).toBe(
      t("diagnostics_uncovered", { repository: "Octo/repo-name" }),
    );
    expect(uncovered.fields[4].value).toBe(t("diagnostics_not_checked"));
    const truncated = buildMatchedAccountDiagnostic(
      {
        repository: "Octo/repo-name",
        coverageStatus: "maybe-covered-truncated",
        account: { login: "Octocat" },
        result: result("token-permission", "token"),
      },
      t,
    );
    expect(truncated.fields[3]).toMatchObject({
      value: t("diagnostics_truncated"),
      tone: "warning",
    });
    expect(truncated.fields[4].value).toBe(t("diagnostics_permission_label"));
  });

  it("preserves both endpoints, statuses, quota/resource values and UTC reset", () => {
    const data = {
      ...result("authenticated-rate-limit", "token"),
      failures: [
        {
          kind: "http" as const,
          httpStatus: 403,
          endpoint: {
            name: "pull" as const,
            method: "GET" as const,
            path: "/repos/Octo/repo-name/pulls/42",
          },
          rateLimit: { ...rate, remaining: 4999 },
        },
        {
          kind: "http" as const,
          httpStatus: 429,
          endpoint: {
            name: "reviews" as const,
            method: "GET" as const,
            path: "/repos/Octo/repo-name/pulls/42/reviews",
          },
          rateLimit: rate,
        },
      ],
    };
    const diagnostic = buildNoTokenDiagnostic(
      { repository: "Octo/repo-name", result: data },
      t,
    );
    const failures = diagnostic.fields.filter(
      (f) => f.label === t("diagnostics_endpoint_failure"),
    );
    expect(failures.map((f) => f.value)).toEqual(
      data.failures.map((f) =>
        t("diagnostics_http_failure", {
          endpoint: `${f.endpoint.method} ${f.endpoint.path}`,
          status: f.httpStatus,
        }),
      ),
    );
    expect(
      diagnostic.fields.filter((f) => f.label === t("diagnostics_rate_limit")),
    ).toEqual([
      {
        label: t("diagnostics_rate_limit"),
        value: t("diagnostics_rate_quota", { remaining: 4999, limit: 5000 }),
        tone: "neutral",
      },
      {
        label: t("diagnostics_rate_limit"),
        value: t("diagnostics_rate_quota", { remaining: 0, limit: 5000 }),
        tone: "error",
      },
    ]);
    expect(
      diagnostic.fields
        .filter((f) => f.label === t("diagnostics_rate_reset"))
        .map((f) => f.value),
    ).toEqual(["2024-03-09 16:00 UTC", "2024-03-09 16:00 UTC"]);
    expect(
      diagnostic.fields
        .filter((f) => f.label === t("diagnostics_rate_resource"))
        .map((f) => f.value),
    ).toEqual(["core", "core"]);
  });

  it("localizes empty, running, input and safe schema/network/unknown errors", () => {
    for (const kind of [
      "empty",
      "running",
      "input-matched",
      "input-no-token",
    ] as const) {
      const view = buildRepositoryDiagnostic({ kind }, t);
      expect(view.message).not.toMatch(/diagnostics_|undefined/);
      if (locale !== "en")
        expect(view.message).not.toBe(
          buildRepositoryDiagnostic({ kind }, createTranslator("en")).message,
        );
    }
    for (const kind of ["schema", "network", "unknown"] as const) {
      const view = buildRepositoryDiagnostic(
        { kind: "failed", failures: [{ kind }] },
        t,
      );
      expect(view.message).toBe(t("diagnostics_run_failed"));
      expect(view.fields[0].value).toContain(t("diagnostics_api_request"));
      expect(view.fields[0].value).not.toContain("HTTP");
    }
  });
});

it("keeps partial quota evidence and legacy primary evidence without inventing missing values", () => {
  for (const remaining of [0, null]) {
    const data = {
      ...result("unknown-error", "no-token"),
      httpStatus: 500,
      rateLimit: {
        limit: remaining == null ? 60 : null,
        remaining,
        resource: null,
        resetAt: null,
      },
    };
    const diagnostic = buildNoTokenDiagnostic({
      repository: "Octo/repo-name",
      result: data,
    });
    expect(diagnostic.fields.at(-1)?.value).toBe(
      remaining == null ? "60" : "0",
    );
    expect(diagnostic.fields.some((f) => f.value.includes("HTTP 500"))).toBe(
      true,
    );
    expect(diagnostic.fields.some((f) => f.label === "Rate-limit reset")).toBe(
      false,
    );
  }
});
