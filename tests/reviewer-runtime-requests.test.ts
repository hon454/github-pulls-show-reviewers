import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchReviewerMetadataBatch,
  fetchReviewerSummary,
  isAbortError,
  requestInstallationsRefresh,
  shouldRetryWithFallbackAccount,
} from "../src/features/reviewers/runtime-requests";
import { ReviewerFetchRuntimeError } from "../src/runtime/reviewer-fetch";

const sendMessage = vi.fn();

beforeEach(() => {
  sendMessage.mockReset();
  vi.stubGlobal("browser", {
    runtime: { sendMessage },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reviewer runtime requests", () => {
  it("unwraps successful summary and metadata responses", async () => {
    const summary = {
      status: "ok" as const,
      requestedUsers: [],
      requestedTeams: [],
      completedReviews: [],
    };
    const metadata = [
      {
        number: "42",
        authorLogin: "author",
        requestedUsers: [],
        requestedTeams: [],
      },
    ];
    sendMessage
      .mockResolvedValueOnce({ ok: true, summary })
      .mockResolvedValueOnce({ ok: true, metadata });

    await expect(
      fetchReviewerSummary({
        account: null,
        owner: "acme",
        repo: "widgets",
        pullNumber: "42",
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(summary);
    await expect(
      fetchReviewerMetadataBatch({
        account: null,
        owner: "acme",
        repo: "widgets",
        targetPullNumbers: ["42"],
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(metadata);
  });

  it("reconstructs a typed runtime error from a failed response", async () => {
    sendMessage.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "github-api",
        status: 403,
        failures: [{ status: 403, endpoint: null, rateLimited: false }],
      },
    });

    await expect(
      fetchReviewerMetadataBatch({
        account: null,
        owner: "acme",
        repo: "widgets",
        targetPullNumbers: ["42"],
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ReviewerFetchRuntimeError);
  });

  it("cancels an in-flight summary request when its signal aborts", async () => {
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === "fetchPullReviewerSummary") {
        return new Promise(() => undefined);
      }
      return Promise.resolve(undefined);
    });
    const controller = new AbortController();

    const request = fetchReviewerSummary({
      account: null,
      owner: "acme",
      repo: "widgets",
      pullNumber: "42",
      signal: controller.signal,
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cancelPullReviewerSummary" }),
    );
  });

  it("classifies abort and fallback-eligible failures", () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";

    expect(isAbortError(abortError)).toBe(true);
    expect(shouldRetryWithFallbackAccount({ status: 401 })).toBe(true);
    expect(shouldRetryWithFallbackAccount({ status: 429 })).toBe(true);
    expect(shouldRetryWithFallbackAccount({ status: 500 })).toBe(false);
  });

  it("treats installation refresh transport failures as unsuccessful", async () => {
    sendMessage
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("extension context closed"));

    await expect(requestInstallationsRefresh("acc-1")).resolves.toBe(true);
    await expect(requestInstallationsRefresh("acc-1")).resolves.toBe(false);
  });
});
