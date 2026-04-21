import { describe, expect, it } from "vitest";

import {
  createScopeString,
  findDuplicateTokenScope,
  maskToken,
  parseTokenScope,
  resolveTokenEntryForRepository,
  validateTokenScopeParts,
  type TokenEntry,
} from "../src/storage/token-scopes";

function makeEntry(
  scope: string,
  token = "github_pat_example_token",
): TokenEntry {
  return {
    id: `${scope}-id`,
    scope,
    token,
    label: null,
  };
}

describe("token scope helpers", () => {
  it("creates an owner-wide scope string", () => {
    expect(createScopeString("hon454", null)).toBe("hon454/*");
  });

  it("creates a repository scope string", () => {
    expect(createScopeString("hon454", "github-pulls-show-reviewers")).toBe(
      "hon454/github-pulls-show-reviewers",
    );
  });

  it("validates owner-wide parts", () => {
    expect(validateTokenScopeParts("hon454", null)).toEqual({
      ok: true,
      scope: "hon454/*",
    });
  });

  it("rejects invalid repository parts", () => {
    expect(validateTokenScopeParts("hon454", "bad/repo")).toEqual({
      ok: false,
      message: "Repository name must not contain slashes.",
    });
  });

  it("parses a normalized owner-wide scope", () => {
    expect(parseTokenScope("hon454/*")).toEqual({
      owner: "hon454",
      repo: null,
      scopeType: "owner",
      scope: "hon454/*",
    });
  });

  it("finds duplicate scopes after normalization", () => {
    const entries = [makeEntry("hon454/*"), makeEntry("openai/gpt-5")];

    expect(findDuplicateTokenScope(entries, "hon454/*")).toEqual(entries[0]);
  });

  it("prefers an exact repository scope over owner-wide scope", () => {
    const settings = {
      tokenEntries: [
        makeEntry("hon454/*", "owner-token"),
        makeEntry("hon454/github-pulls-show-reviewers", "repo-token"),
      ],
    };

    expect(
      resolveTokenEntryForRepository(
        settings,
        "hon454/github-pulls-show-reviewers",
      ),
    ).toMatchObject({
      scope: "hon454/github-pulls-show-reviewers",
      token: "repo-token",
    });
  });

  it("falls back to owner-wide scope when no exact repo match exists", () => {
    const settings = {
      tokenEntries: [makeEntry("hon454/*", "owner-token")],
    };

    expect(
      resolveTokenEntryForRepository(settings, "hon454/another-repo"),
    ).toMatchObject({
      scope: "hon454/*",
      token: "owner-token",
    });
  });

  it("returns null when no token scope matches the repository", () => {
    const settings = {
      tokenEntries: [makeEntry("openai/*", "owner-token")],
    };

    expect(
      resolveTokenEntryForRepository(
        settings,
        "hon454/github-pulls-show-reviewers",
      ),
    ).toBeNull();
  });

  it("masks tokens to the last four characters", () => {
    expect(maskToken("github_pat_1234567890")).toBe("••••7890");
  });
});
