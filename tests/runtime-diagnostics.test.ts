import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { diagnoseRepository } from "../src/runtime/diagnostics";
import { resolveFallbackAccount } from "../src/runtime/accounts";
import { deferred } from "./helpers/ui-bridge-harness";

const sendMessage = vi.fn();
beforeEach(() => {
  sendMessage.mockReset();
  vi.stubGlobal("browser", { runtime: { sendMessage } });
});
afterEach(() => vi.unstubAllGlobals());

it("does not dispatch an already cancelled diagnostic", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    diagnoseRepository("owner", "repo", "matched", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(sendMessage).not.toHaveBeenCalled();
});

it("cancels only the active run and ignores a late result when cancellation delivery fails", async () => {
  const reply = deferred<unknown>();
  sendMessage
    .mockReturnValueOnce(reply.promise)
    .mockRejectedValueOnce(new Error("offline"));
  const controller = new AbortController();
  const work = diagnoseRepository(
    "owner",
    "repo",
    "matched",
    controller.signal,
  );
  const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
  const request = sendMessage.mock.calls[0][0];
  controller.abort();
  await rejected;
  expect(sendMessage.mock.calls[1][0]).toEqual({
    type: "cancelRepositoryDiagnostic",
    runId: request.runId,
  });
  reply.resolve({
    ok: true,
    data: { kind: "uncovered", repository: "owner/repo" },
  });
  await Promise.resolve();
  expect(sendMessage).toHaveBeenCalledTimes(2);
});

it("removes cancellation listeners after a failed diagnostic", async () => {
  sendMessage.mockResolvedValue({ ok: false, error: "unavailable" });
  const controller = new AbortController();
  await expect(
    diagnoseRepository("owner", "repo", "matched", controller.signal),
  ).rejects.toThrow();
  controller.abort();
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

it("validates fallback account replies at the UI boundary", async () => {
  sendMessage.mockResolvedValueOnce({ ok: true, data: null });
  await expect(resolveFallbackAccount("owner", "repo")).resolves.toBeNull();
  expect(sendMessage).toHaveBeenCalledWith({
    type: "resolveFallbackAccount",
    owner: "owner",
    repo: "repo",
  });
  sendMessage.mockResolvedValueOnce({ ok: true, data: { token: "synthetic" } });
  await expect(resolveFallbackAccount("owner", "repo")).rejects.toThrow();
});

it("preserves safe timeout facts through diagnostic parsing without inventing HTTP status", async () => {
  const { diagnosticFailureSchema, repositoryDiagnosticSchema } =
    await import("../src/runtime/diagnostics");
  const { extractRepositoryValidationFailures } =
    await import("../src/github/api");
  const { ReviewerTimeoutError } =
    await import("../src/shared/reviewer-deadline");
  const failures = extractRepositoryValidationFailures(
    new ReviewerTimeoutError(),
  );
  expect(failures).toEqual([{ kind: "timeout" }]);
  expect(diagnosticFailureSchema.parse(failures[0])).toEqual({
    kind: "timeout",
  });
  expect(
    repositoryDiagnosticSchema.parse({ kind: "failed", failures }),
  ).toEqual({ kind: "failed", failures });
});
