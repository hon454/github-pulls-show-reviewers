import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchReviewerMetadataBatch,
  fetchReviewerSummary,
  isAbortError,
  shouldRetryWithFallbackAccount,
} from "../src/features/reviewers/runtime-requests";
import { refreshAccountInstallations } from "../src/runtime/installation-refresh";
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
    ).resolves.toEqual(summary);
    await expect(
      fetchReviewerMetadataBatch({
        account: null,
        owner: "acme",
        repo: "widgets",
        targetPullNumbers: ["42"],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(metadata);
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

  it("validates installation outcomes and reports transport failure", async () => {
    sendMessage
      .mockResolvedValueOnce({ ok: true, data: { ok: true } })
      .mockRejectedValueOnce(new Error("extension context closed"));

    await expect(refreshAccountInstallations("acc-1")).resolves.toEqual({
      ok: true,
    });
    await expect(refreshAccountInstallations("acc-1")).rejects.toThrow(
      "extension context closed",
    );
  });
});

describe("dispatched reviewer RPC watchdog", () => {
  afterEach(() => vi.useRealTimers());

  const args = () => ({
    account: null,
    owner: "acme",
    repo: "widgets",
    pullNumber: "42",
    targetPullNumbers: ["42"],
    signal: new AbortController().signal,
  });
  const result = {
    status: "ok",
    requestedUsers: [],
    requestedTeams: [],
    completedReviews: [],
  };

  it.each(["summary", "metadata"])(
    "fails lost %s replies at 35s and sends one cancellation",
    async (kind) => {
      vi.useFakeTimers();
      let reply!: (value: unknown) => void;
      const onAccount = vi.fn();
      sendMessage.mockImplementation((message: { type: string }) =>
        message.type === "cancelPullReviewerSummary"
          ? Promise.resolve(undefined)
          : new Promise((resolve) => {
              reply = resolve;
            }),
      );
      const work = (
        kind === "summary" ? fetchReviewerSummary : fetchReviewerMetadataBatch
      )({ ...args(), onAccount }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(34_999);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await work).toMatchObject({
        envelope: {
          status: null,
          failures: [{ kind: "timeout", status: null }],
        },
      });
      const requestId = sendMessage.mock.calls[0][0].requestId;
      expect(sendMessage).toHaveBeenLastCalledWith({
        type: "cancelPullReviewerSummary",
        requestId,
      });
      reply({ ok: true, summary: result, metadata: [], account: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(onAccount).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([34_999, 35_000, 35_001])(
    "settles reply/watchdog boundary once at %sms",
    async (delay) => {
      vi.useFakeTimers();
      sendMessage.mockImplementation((message: { type: string }) =>
        message.type === "cancelPullReviewerSummary"
          ? Promise.resolve(undefined)
          : new Promise((resolve) =>
              setTimeout(() => resolve({ ok: true, summary: result }), delay),
            ),
      );
      const work = fetchReviewerSummary(args()).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(35_001);
      if (delay < 35_000) expect(await work).toEqual(result);
      else expect(await work).toBeInstanceOf(ReviewerFetchRuntimeError);
      expect(sendMessage).toHaveBeenCalledTimes(delay < 35_000 ? 1 : 2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("external cancellation wins without timeout or duplicate cancellation", async () => {
    vi.useFakeTimers();
    sendMessage.mockImplementation((message: { type: string }) =>
      message.type === "cancelPullReviewerSummary"
        ? Promise.resolve(undefined)
        : new Promise(() => {}),
    );
    const controller = new AbortController();
    const work = fetchReviewerSummary({
      ...args(),
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(34_999);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    expect(await work).toMatchObject({ name: "AbortError" });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
