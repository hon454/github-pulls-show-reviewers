import {
  compareVersions,
  inspectStatus,
  requireCondition,
  requireReadiness,
  validateReceipt,
} from "./policy.ts";
import type { Receipt, StoreStatus } from "./policy.ts";
import type { HistoryEntry } from "./provenance.ts";

export type ReleaseTarget = Pick<
  Receipt,
  "repository" | "sourceSha" | "version" | "publisherId" | "itemId"
>;

export function selectPriorReceipt(
  target: ReleaseTarget,
  history: HistoryEntry[],
  runId?: string,
) {
  for (const entry of history) {
    validateReceipt(entry.receipt, {
      ...entry.receipt,
      repository: target.repository,
      publisherId: target.publisherId,
      itemId: target.itemId,
    });
  }
  const candidates = history.filter(
    (entry) =>
      entry.complete &&
      entry.receipt.sourceSha === target.sourceSha &&
      ["SUCCEEDED", "IN_PROGRESS"].includes(entry.receipt.upload) &&
      (!runId || entry.receipt.runId === runId),
  );
  requireCondition(
    runId ? candidates.length === 1 : candidates.length <= 1,
    "Missing or ambiguous original upload receipt; inspect the receipt history.",
  );
  const prior = candidates[0]?.receipt;
  if (prior) validateReceipt(prior, target);
  return prior;
}

// Shared by timestamped observations and the fresh pre-mutation check.
export function inspectReleaseHistory(input: {
  target: ReleaseTarget;
  status: StoreStatus;
  history: HistoryEntry[];
  prior?: Receipt;
}) {
  const state = inspectStatus(input.status, input.target, input.target.version);
  const outstanding = input.history.filter((entry) => {
    if (entry.receipt.sourceSha === input.target.sourceSha) return false;
    if (entry.complete && !entry.receipt.mutationStarted) return false;
    return !input.status.publishedItemRevisionStatus?.distributionChannels.every(
      (channel) =>
        compareVersions(channel.crxVersion, entry.receipt.version) >= 0 &&
        entry.receipt.version !== input.target.version,
    );
  });
  requireReadiness(
    !outstanding.length,
    "outstanding-release",
    "Another release has an unresolved upload or draft; inspect its receipt before replacing it.",
    "Read the other release intent/result and API status. Resolve its outcome before replacing it; dashboard inspection is only for a specific unavailable draft-continuity fact.",
  );
  if (state === "pending" || state === "published") {
    const recoveredSubmission = input.history.some(
      (entry) =>
        entry.complete &&
        entry.receipt.sourceSha === input.target.sourceSha &&
        entry.receipt.priorReceiptRunId === input.prior?.runId &&
        entry.receipt.submission === "CONFIRMED" &&
        entry.receipt.package.zipSha256 === input.prior?.package.zipSha256,
    );
    requireReadiness(
      input.prior?.upload === "SUCCEEDED" || recoveredSubmission,
      "unverified-version",
      "Version equality alone is insufficient; a confirmed source/package receipt is required.",
      "Recover and validate the original upload/package receipts through GitHub; do not upload or submit again based on version equality.",
    );
    return state;
  }
  return state;
}

export function requireCertainHistory(
  target: ReleaseTarget,
  history: HistoryEntry[],
  prior?: Receipt,
  recoveredAsync = false,
) {
  const uncertain = history.some(
    (entry) =>
      entry.receipt.sourceSha === target.sourceSha &&
      (!entry.complete ||
        entry.receipt.upload === "UNKNOWN" ||
        (entry.receipt.upload === "IN_PROGRESS" &&
          !(recoveredAsync && entry.receipt.runId === prior?.runId)) ||
        entry.receipt.submission !== "NOT_ATTEMPTED"),
  );
  requireReadiness(
    !uncertain,
    "uncertain-write",
    "An earlier attempt is uncertain; inspect its receipt and API status before an explicit recovery decision.",
    "Inspect original intent/result and API status first. Use targeted draft-continuity observation only if the API cannot resolve it, then obtain an explicit recovery decision.",
  );
}
