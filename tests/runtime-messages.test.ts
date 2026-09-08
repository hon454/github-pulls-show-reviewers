import { describe, expect, it } from "vitest";
import { uiRequestSchema } from "../src/runtime/ui-contract";
import { connectInput } from "./helpers/auth-harness";

import {
  cancelPullReviewerSummaryMessageSchema,
  fetchPullReviewerMetadataBatchMessageSchema,
  fetchPullReviewerSummaryMessageSchema,
  isCancelPullReviewerSummaryMessage,
  isFetchPullReviewerMetadataBatchMessage,
  isFetchPullReviewerSummaryMessage,
} from "../src/runtime/reviewer-fetch";
import {
  isRefreshAccountInstallationsMessage,
  refreshAccountInstallationsMessageSchema,
} from "../src/runtime/installation-refresh";
import {
  isOpenOptionsPageMessage,
  openOptionsPageMessageSchema,
} from "../src/runtime/options-page";

describe("reviewer fetch runtime message schemas", () => {
  it("accepts valid fetch-summary messages through the schema-backed guard", () => {
    const message = {
      type: "fetchPullReviewerSummary",
      requestId: "req-1",
      owner: "cinev",
      repo: "shotloom",
      pullNumber: "42",
      accountId: null,
      pullMetadata: {
        number: "42",
        authorLogin: "octocat",
        requestedUsers: [{ login: "hubot", avatarUrl: null }],
        requestedTeams: ["reviewers"],
      },
    };

    expect(
      fetchPullReviewerSummaryMessageSchema.safeParse(message).success,
    ).toBe(true);
    expect(isFetchPullReviewerSummaryMessage(message)).toBe(true);
  });

  it("rejects malformed nested pull metadata through the fetch-summary guard", () => {
    const message = {
      type: "fetchPullReviewerSummary",
      requestId: "req-1",
      owner: "cinev",
      repo: "shotloom",
      pullNumber: "42",
      accountId: null,
      pullMetadata: {
        number: "42",
        authorLogin: "octocat",
        requestedUsers: [{ login: "", avatarUrl: null }],
        requestedTeams: ["reviewers"],
      },
    };

    expect(
      fetchPullReviewerSummaryMessageSchema.safeParse(message).success,
    ).toBe(false);
    expect(isFetchPullReviewerSummaryMessage(message)).toBe(false);
  });

  it("accepts cancel and metadata-batch messages through their schema-backed guards", () => {
    const cancelMessage = {
      type: "cancelPullReviewerSummary",
      requestId: "req-1",
    };
    const batchMessage = {
      type: "fetchPullReviewerMetadataBatch",
      requestId: "req-2",
      owner: "cinev",
      repo: "shotloom",
      accountId: "acc-1",
      targetPullNumbers: ["42", "41"],
    };

    expect(
      cancelPullReviewerSummaryMessageSchema.safeParse(cancelMessage).success,
    ).toBe(true);
    expect(isCancelPullReviewerSummaryMessage(cancelMessage)).toBe(true);
    expect(
      fetchPullReviewerMetadataBatchMessageSchema.safeParse(batchMessage)
        .success,
    ).toBe(true);
    expect(isFetchPullReviewerMetadataBatchMessage(batchMessage)).toBe(true);
  });
});

describe("installation refresh runtime message schema", () => {
  it("accepts valid refresh-installations messages through the schema-backed guard", () => {
    const message = {
      type: "refreshAccountInstallations",
      accountId: "acc-1",
    };

    expect(
      refreshAccountInstallationsMessageSchema.safeParse(message).success,
    ).toBe(true);
    expect(isRefreshAccountInstallationsMessage(message)).toBe(true);
  });

  it("rejects blank account ids through the schema-backed guard", () => {
    const message = {
      type: "refreshAccountInstallations",
      accountId: " ",
    };

    expect(
      refreshAccountInstallationsMessageSchema.safeParse(message).success,
    ).toBe(false);
    expect(isRefreshAccountInstallationsMessage(message)).toBe(false);
  });
});

describe("options page runtime message schema", () => {
  it("accepts the payload-free open-options message", () => {
    const message = { type: "openOptionsPage" };

    expect(openOptionsPageMessageSchema.safeParse(message).success).toBe(true);
    expect(isOpenOptionsPageMessage(message)).toBe(true);
  });

  it("rejects extra fields on the payload-free open-options message", () => {
    const message = {
      type: "openOptionsPage",
      url: "chrome-extension://other/options.html",
    };

    expect(openOptionsPageMessageSchema.safeParse(message).success).toBe(false);
    expect(isOpenOptionsPageMessage(message)).toBe(false);
  });
});

describe("account auth and mutation runtime schemas", () => {
  it.each([
    "refreshAccessToken",
    "invalidateAccessToken",
    "upsertAccountByLogin",
  ])("rejects the retired %s credential capability in every shape", (type) => {
    for (const message of [
      { type },
      { type, accountId: "acc-1", generation: "g0" },
      { type, input: connectInput() },
    ]) {
      expect(uiRequestSchema.safeParse(message).success).toBe(false);
    }
  });

  it("requires a nonblank removal identity and rejects extra fields", () => {
    expect(
      uiRequestSchema.safeParse({
        type: "removeAccount",
        accountId: "acc-1",
      }).success,
    ).toBe(true);
    for (const message of [
      { type: "removeAccount" },
      { type: "removeAccount", accountId: " " },
      { type: "removeAccount", accountId: 1 },
      { type: "removeAccount", accountId: "acc-1", input: {} },
    ]) {
      expect(uiRequestSchema.safeParse(message).success).toBe(false);
    }
  });
});
