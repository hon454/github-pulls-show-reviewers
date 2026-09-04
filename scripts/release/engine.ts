import {
  compareVersions,
  inspectStatus,
  parse,
  ReleaseError,
  requireCondition,
  statusSchema,
  validateEvidence,
  validateReceipt,
} from "./policy.ts";
import type { Receipt } from "./policy.ts";
import type { HistoryEntry } from "./provenance.ts";

export interface StorePort {
  status(): Promise<unknown>;
  upload(): Promise<"SUCCEEDED" | "IN_PROGRESS">;
  publish(): Promise<void>;
}

export async function executeRelease(input: {
  receipt: Receipt;
  prior?: Receipt;
  history: HistoryEntry[];
  evidence?: unknown;
  store: StorePort;
  checkpoint: (receipt: Receipt) => Promise<void>;
}) {
  const receipt = { ...input.receipt };
  try {
    validateReceipt(receipt, receipt);
    if (input.prior) {
      validateReceipt(input.prior, receipt);
      requireCondition(
        input.prior.package.zipSha256 === receipt.package.zipSha256,
        "Original checked package digest mismatch.",
      );
    }
    requireCondition(
      receipt.checked && receipt.outcome === "INTENT",
      "Checked package intent is required.",
    );
    requireCondition(
      ["publish", "upload-only", "submit-existing"].includes(receipt.action),
      "This action cannot mutate CWS.",
    );
    const status = parse(
      statusSchema,
      await input.store.status(),
      "CWS status",
    );
    const state = inspectStatus(status, receipt, receipt.version);
    const outstanding = input.history.filter((entry) => {
      if (entry.receipt.sourceSha === receipt.sourceSha) return false;
      if (entry.complete && !entry.receipt.mutationStarted) return false;
      return !status.publishedItemRevisionStatus?.distributionChannels.every(
        (channel) =>
          compareVersions(channel.crxVersion, entry.receipt.version) >= 0 &&
          entry.receipt.version !== receipt.version,
      );
    });
    requireCondition(
      !outstanding.length,
      "Another release has an unresolved upload or draft; inspect its receipt before replacing it.",
    );
    if (state === "pending" || state === "published") {
      const recoveredSubmission = input.history.some(
        (entry) =>
          entry.complete &&
          entry.receipt.sourceSha === receipt.sourceSha &&
          entry.receipt.priorReceiptRunId === input.prior?.runId &&
          entry.receipt.submission === "CONFIRMED" &&
          entry.receipt.package.zipSha256 === input.prior?.package.zipSha256,
      );
      requireCondition(
        input.prior?.upload === "SUCCEEDED" || recoveredSubmission,
        "Version equality alone is insufficient; a confirmed source/package receipt is required.",
      );
      receipt.outcome =
        state === "pending" ? "ALREADY_PENDING" : "ALREADY_PUBLISHED";
      return { receipt };
    }
    const evidence =
      receipt.action === "submit-existing" && input.prior
        ? validateEvidence(input.evidence, input.prior)
        : undefined;
    const recoveredAsync =
      input.prior?.upload === "IN_PROGRESS" &&
      evidence?.asyncUploadConfirmed === true &&
      status.lastAsyncUploadState === "SUCCEEDED";
    const uncertain = input.history.some(
      (entry) =>
        entry.receipt.sourceSha === receipt.sourceSha &&
        (!entry.complete ||
          entry.receipt.upload === "UNKNOWN" ||
          (entry.receipt.upload === "IN_PROGRESS" &&
            !(recoveredAsync && entry.receipt.runId === input.prior?.runId)) ||
          entry.receipt.submission !== "NOT_ATTEMPTED"),
    );
    requireCondition(
      !uncertain,
      "An earlier attempt is uncertain; inspect its receipt and dashboard before an explicit recovery decision.",
    );
    if (receipt.action === "submit-existing") {
      requireCondition(
        input.prior?.upload === "SUCCEEDED" || recoveredAsync,
        "submit-existing requires a confirmed upload receipt or explicit async recovery evidence.",
      );
      requireCondition(input.prior, "An upload receipt is required.");
      requireCondition(
        input.prior.submission === "NOT_ATTEMPTED",
        "An earlier submission is uncertain or no longer pending; do not resubmit automatically.",
      );
    } else {
      requireCondition(
        !input.prior,
        "This source already has an upload receipt; use submit-existing after the listing handoff.",
      );
      receipt.mutationStarted = true;
      receipt.upload = "UNKNOWN";
      await input.checkpoint(receipt);
      receipt.upload = await input.store.upload();
      requireCondition(
        receipt.upload === "SUCCEEDED",
        "Upload is in progress; inspect fetchStatus and the dashboard without reuploading.",
      );
      receipt.outcome = "UPLOADED";
      await input.checkpoint(receipt);
      if (receipt.action === "upload-only") return { receipt };
      requireCondition(
        inspectStatus(await input.store.status(), receipt, receipt.version) ===
          "draft",
        "Store state changed after upload; stop for inspection.",
      );
    }
    receipt.mutationStarted = true;
    receipt.submission = "UNKNOWN";
    await input.checkpoint(receipt);
    await input.store.publish();
    receipt.submission = "CONFIRMED";
    receipt.outcome = "SUBMITTED";
    return { receipt };
  } catch (error) {
    receipt.outcome = receipt.mutationStarted ? "UNCERTAIN" : "STOPPED";
    return {
      receipt,
      error:
        error instanceof ReleaseError
          ? error.message
          : "Release operation failed or is uncertain; inspect receipts and dashboard. No write was retried.",
    };
  }
}
