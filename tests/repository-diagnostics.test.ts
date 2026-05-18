import { describe, expect, it } from "vitest";

import {
  buildMatchedAccountDiagnostic,
  buildNoTokenDiagnostic,
  buildUncoveredAccountDiagnostic,
} from "../src/features/repository-diagnostics";
import type {
  GitHubRateLimitSnapshot,
  RepositoryValidationResult,
} from "../src/github/api";
import type { Account } from "../src/storage/accounts";

function account(partial: Partial<Account> = {}): Account {
  return {
    id: "acct_1",
    login: "octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    token: "ghu_example",
    createdAt: 1710000000,
    installations: [],
    installationsRefreshedAt: 1710000000,
    invalidated: false,
    invalidatedReason: null,
    refreshToken: null,
    expiresAt: null,
    refreshTokenExpiresAt: null,
    ...partial,
  };
}

function validationResult(
  partial: Partial<RepositoryValidationResult> = {},
): RepositoryValidationResult {
  return {
    ok: true,
    authMode: "token",
    outcome: "accessible",
    message: "Repository diagnostics checked pull #42 in octo/repo.",
    fullName: "octo/repo",
    pullNumber: "42",
    ...partial,
  } as RepositoryValidationResult;
}

describe("repository diagnostics view model", () => {
  it("builds success fields for a matched account diagnostic", () => {
    const diagnostic = buildMatchedAccountDiagnostic({
      repository: "octo/repo",
      coverageStatus: "covered",
      account: account({ login: "octocat" }),
      result: validationResult({
        endpoint: {
          name: "reviews",
          method: "GET",
          path: "/repos/octo/repo/pulls/42/reviews",
        },
        httpStatus: 200,
      }),
    });

    expect(diagnostic).toEqual({
      tone: "success",
      message: "Repository diagnostics checked pull #42 in octo/repo.",
      fields: [
        { label: "Repository", value: "octo/repo", tone: "neutral" },
        { label: "Matched account", value: "@octocat", tone: "success" },
        { label: "Auth mode", value: "Matched account token", tone: "success" },
        { label: "Installation coverage", value: "Covered", tone: "success" },
        {
          label: "Endpoint result",
          value: "Accessible",
          tone: "success",
        },
      ],
    });
  });

  it("builds an uncovered diagnostic without repository validation", () => {
    expect(
      buildUncoveredAccountDiagnostic(
        "octo/private-repo",
        "No signed-in account covers this repository.",
      ),
    ).toEqual({
      tone: "error",
      message: "No signed-in account covers this repository.",
      fields: [
        { label: "Repository", value: "octo/private-repo", tone: "neutral" },
        { label: "Matched account", value: "None", tone: "error" },
        { label: "Auth mode", value: "Not checked", tone: "neutral" },
        { label: "Installation coverage", value: "Uncovered", tone: "error" },
        { label: "Endpoint result", value: "Not checked", tone: "neutral" },
      ],
    });
  });

  it("includes truncated coverage and rate-limit evidence with formatted reset time", () => {
    const rateLimit: GitHubRateLimitSnapshot = {
      limit: 60,
      remaining: 0,
      resource: "core",
      resetAt: 1710000000,
    };

    const diagnostic = buildMatchedAccountDiagnostic({
      repository: "octo/repo",
      coverageStatus: "maybe-covered-truncated",
      account: account(),
      result: validationResult({
        ok: false,
        outcome: "authenticated-rate-limit",
        authMode: "token",
        message: "Repository diagnostics failed for octo/repo.",
        fullName: "octo/repo",
        endpoint: {
          name: "pulls-list",
          method: "GET",
          path: "/repos/octo/repo/pulls",
        },
        httpStatus: 403,
        rateLimit,
      }),
    });

    expect(diagnostic).toEqual({
      tone: "error",
      message: "Repository diagnostics failed for octo/repo.",
      fields: [
        { label: "Repository", value: "octo/repo", tone: "neutral" },
        { label: "Matched account", value: "@octocat", tone: "success" },
        { label: "Auth mode", value: "Matched account token", tone: "success" },
        {
          label: "Installation coverage",
          value: "Maybe covered - local snapshot truncated",
          tone: "warning",
        },
        {
          label: "Endpoint result",
          value: "Signed-in rate limit",
          tone: "error",
        },
        {
          label: "Rate limit",
          value: "0 of 60 remaining, resource core, resets at 2024-03-09 16:00 UTC",
          tone: "error",
        },
      ],
    });
  });

  it("builds no-token diagnostics with unchecked account and coverage fields", () => {
    const diagnostic = buildNoTokenDiagnostic({
      repository: "octo/repo",
      result: validationResult({
        ok: false,
        authMode: "no-token",
        outcome: "unauthenticated-rate-limit",
        message: "Repository diagnostics failed for octo/repo.",
        rateLimit: {
          limit: 60,
          remaining: 0,
          resource: "core",
          resetAt: 1710000000,
        },
      }),
    });

    expect(diagnostic).toEqual({
      tone: "error",
      message: "Repository diagnostics failed for octo/repo.",
      fields: [
        { label: "Repository", value: "octo/repo", tone: "neutral" },
        { label: "Matched account", value: "Not checked", tone: "neutral" },
        { label: "Auth mode", value: "No token", tone: "neutral" },
        {
          label: "Installation coverage",
          value: "Not checked",
          tone: "neutral",
        },
        {
          label: "Endpoint result",
          value: "Unauthenticated rate limit",
          tone: "error",
        },
        {
          label: "Rate limit",
          value: "0 of 60 remaining, resource core, resets at 2024-03-09 16:00 UTC",
          tone: "error",
        },
      ],
    });
  });

  it("maps token-invalid and token-permission outcomes to user-facing endpoint labels", () => {
    const tokenInvalid = buildMatchedAccountDiagnostic({
      repository: "octo/repo",
      coverageStatus: "covered",
      account: account(),
      result: validationResult({
        ok: false,
        outcome: "token-invalid",
        message: "Token failed.",
      }),
    });
    const tokenPermission = buildMatchedAccountDiagnostic({
      repository: "octo/repo",
      coverageStatus: "covered",
      account: account(),
      result: validationResult({
        ok: false,
        outcome: "token-permission",
        message: "Permission failed.",
      }),
    });

    expect(tokenInvalid.fields).toContainEqual({
      label: "Endpoint result",
      value: "Token expired",
      tone: "error",
    });
    expect(tokenPermission.fields).toContainEqual({
      label: "Endpoint result",
      value: "GitHub App installation missing",
      tone: "error",
    });
  });

  it("keeps non-exhausted rate-limit evidence neutral on unrelated failures", () => {
    const diagnostic = buildMatchedAccountDiagnostic({
      repository: "octo/repo",
      coverageStatus: "covered",
      account: account(),
      result: validationResult({
        ok: false,
        outcome: "token-not-found",
        message: "Repository was not found.",
        rateLimit: {
          limit: 5000,
          remaining: 4999,
          resource: "core",
          resetAt: null,
        },
      }),
    });

    expect(diagnostic.fields).toContainEqual({
      label: "Rate limit",
      value: "4999 of 5000 remaining, resource core",
      tone: "neutral",
    });
  });
});
