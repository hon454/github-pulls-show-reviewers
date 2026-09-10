import { z } from "zod";
import { listingAssessmentSchema } from "./listing.ts";
import type { ListingAssessment } from "./listing.ts";
import type { StorePort } from "./engine.ts";
import {
  parse,
  inspectStatus,
  receiptSchema,
  ReadinessError,
  requireCondition,
  shaSchema,
  statusSchema,
} from "./policy.ts";
import type { Receipt, StoreStatus } from "./policy.ts";
import type { HistoryEntry } from "./provenance.ts";
import {
  inspectReleaseHistory,
  requireCertainHistory,
  selectPriorReceipt,
} from "./readiness.ts";

export const targetSchema = receiptSchema.pick({
  repository: true,
  sourceSha: true,
  version: true,
  publisherId: true,
  itemId: true,
});
const blockerSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  nextAction: z.string(),
});
export const statusReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observedAt: z.iso.datetime(),
  target: targetSchema,
  workflowSha: shaSchema,
  observationOnly: z.literal(true),
  remote: z.strictObject({
    published: statusSchema.shape.publishedItemRevisionStatus
      .unwrap()
      .nullable(),
    submitted: statusSchema.shape.submittedItemRevisionStatus
      .unwrap()
      .nullable(),
    lastAsyncUploadState: statusSchema.shape.lastAsyncUploadState
      .unwrap()
      .or(z.literal("unknown")),
    warned: z.boolean().or(z.literal("unknown")),
    takenDown: z.boolean().or(z.literal("unknown")),
    draftVersion: z.literal("unknown"),
    draftZipSha256: z.literal("unknown"),
    draftExists: z.literal("unknown"),
    observed: z.boolean(),
  }),
  listing: listingAssessmentSchema.extend({ nextAction: z.string() }),
  receipts: z.array(
    receiptSchema
      .pick({
        runId: true,
        sourceSha: true,
        version: true,
        package: true,
        upload: true,
        submission: true,
        outcome: true,
      })
      .extend({ complete: z.boolean() }),
  ),
  route: z.enum([
    "ordinary-release",
    "staged-listing",
    "targeted-reconciliation",
    "reuse-pending",
    "reuse-published",
    "blocked",
  ]),
  blockers: z.array(blockerSchema),
  nextAction: z.string(),
});
export type StatusReport = z.infer<typeof statusReportSchema>;

// Read-only dependencies deliberately omit upload, publish, checkpoint and package creation.
export async function observeRelease(input: {
  target: z.infer<typeof targetSchema>;
  workflowSha: string;
  store: Pick<StorePort, "status">;
  history: () => Promise<HistoryEntry[]>;
  verifyPackage: (receipt: Receipt) => Promise<void>;
  listing: ListingAssessment;
  receiptRunId?: string;
  now?: () => Date;
}): Promise<StatusReport> {
  const target = parse(targetSchema, input.target, "status target");
  const workflowSha = parse(
    shaSchema,
    input.workflowSha,
    "status workflow SHA",
  );
  const listing = parse(
    listingAssessmentSchema,
    input.listing,
    "listing assessment",
  );
  let status: StoreStatus | undefined;
  let history: HistoryEntry[] = [];
  let prior: Receipt | undefined;
  const blockers: StatusReport["blockers"] = [];
  let route: StatusReport["route"] = "blocked";
  let nextAction = "Resolve the reported blockers and run status again.";
  try {
    status = parse(statusSchema, await input.store.status(), "CWS status");
    requireCondition(
      status.name ===
        `publishers/${target.publisherId}/items/${target.itemId}` &&
        status.itemId === target.itemId,
      "CWS item identity mismatch.",
    );
  } catch {
    status = undefined;
    blockers.push({
      code: "status-unavailable",
      message:
        "CWS status is unavailable, malformed or identifies another item.",
      nextAction:
        "Check item configuration/authentication and retry read-only API observation. Raw errors are suppressed.",
    });
  }
  if (status) {
    try {
      inspectStatus(status, target, target.version);
    } catch (error) {
      blockers.push(readinessBlocker(error));
    }
  }
  try {
    history = await input.history();
    prior = selectPriorReceipt(target, history, input.receiptRunId);
    if (prior) await input.verifyPackage(prior);
  } catch {
    // Never export unvalidated or partially loaded history or raw remote errors.
    history = [];
    prior = undefined;
    blockers.push({
      code: "provenance-unavailable",
      message:
        "Receipt/source/package provenance is missing, conflicting or unavailable.",
      nextAction:
        "Inspect GitHub intent/result runs and artifact integrity/retention. If a release is still running, wait for completion and repeat read-only status. Otherwise restore trusted evidence or obtain an explicit recovery decision; do not retry writes.",
    });
  }
  if (status && !blockers.length) {
    try {
      const state = inspectReleaseHistory({
        target,
        status,
        history,
        ...(prior ? { prior } : {}),
      });
      if (state === "pending" || state === "published") {
        route = state === "pending" ? "reuse-pending" : "reuse-published";
        nextAction =
          "Reuse the verified original package under separate release authority; never reupload or repeat its submission. Observe publication through the API.";
      } else {
        requireCertainHistory(target, history, prior);
        route =
          listing.state === "unchanged" && !prior
            ? "ordinary-release"
            : listing.state === "changed" || prior
              ? "staged-listing"
              : "targeted-reconciliation";
        nextAction =
          route === "ordinary-release"
            ? "Ordinary readiness checks need no browser. Use the separately authorized guarded release path, which performs fresh API/receipt validation and checked packaging."
            : prior
              ? "Preserve the original upload. Complete scoped listing/draft-continuity evidence and use authorized submit-existing; never reupload."
              : listing.state === "changed"
                ? "Use authorized checked upload-only, edit only changed listings, record saved/reopened evidence, then submit-existing."
                : "Reconcile the missing/conflicting saved-listing baseline against the five locales and record actual saved-content evidence. Local equality alone is insufficient.";
      }
    } catch (error) {
      blockers.push(readinessBlocker(error));
    }
  }
  if (["missing", "conflicting"].includes(listing.state)) {
    blockers.push({
      code: `listing-${listing.state}`,
      message:
        "Saved-listing evidence is missing or conflicts with the target item/source.",
      nextAction:
        "Perform scoped saved-content reconciliation for the affected locales and record a reviewed baseline. Do not infer dashboard contents from local hashes.",
    });
  }
  const listingAction = listingNextAction(listing, route, blockers.length > 0);
  const reuse = route === "reuse-pending" || route === "reuse-published";
  if (blockers.length) {
    const blockerActions = blockers.map((b) => b.nextAction).join(" ");
    nextAction = reuse ? `${nextAction} ${blockerActions}` : blockerActions;
  }
  if (reuse) nextAction += ` ${listingAction}`;
  // Never copy the raw API object: publicKey and unknown fields are intentionally dropped.
  return parse(
    statusReportSchema,
    {
      schemaVersion: 1,
      observedAt: (input.now ?? (() => new Date()))().toISOString(),
      target,
      workflowSha,
      observationOnly: true,
      remote: {
        published: status?.publishedItemRevisionStatus ?? null,
        submitted: status?.submittedItemRevisionStatus ?? null,
        lastAsyncUploadState: status?.lastAsyncUploadState ?? "unknown",
        warned: status?.warned ?? "unknown",
        takenDown: status?.takenDown ?? "unknown",
        draftVersion: "unknown",
        draftZipSha256: "unknown",
        draftExists: "unknown",
        observed: Boolean(status),
      },
      listing: { ...listing, nextAction: listingAction },
      receipts: history.map(({ receipt: r, complete }) => ({
        runId: r.runId,
        sourceSha: r.sourceSha,
        version: r.version,
        package: r.package,
        upload: r.upload,
        submission: r.submission,
        outcome: r.outcome,
        complete,
      })),
      route,
      blockers,
      nextAction,
    },
    "sanitized status report",
  );
}

export function statusSummary(report: StatusReport): string {
  const revision = (value: StatusReport["remote"]["published"]) =>
    value
      ? `${value.state} (${value.distributionChannels.map((c) => c.crxVersion).join(", ")})`
      : "not observed";
  return [
    "## Chrome Web Store status",
    "",
    `Observed: ${report.observedAt}. Timestamped observation only; this is not release authorization.`,
    "",
    "| Field | Observation |",
    "| --- | --- |",
    `| Item | ${report.target.publisherId}/${report.target.itemId} |`,
    `| Target | ${report.target.sourceSha}, version ${report.target.version} |`,
    `| Workflow | ${report.workflowSha} |`,
    `| Published | ${revision(report.remote.published)} |`,
    `| Submitted | ${revision(report.remote.submitted)} |`,
    `| Async upload | ${report.remote.lastAsyncUploadState} |`,
    `| Warned / taken down | ${report.remote.warned} / ${report.remote.takenDown} |`,
    "| Remote draft existence / version / ZIP hash | unknown / unknown / unknown |",
    `| Package / release route | ${report.route} |`,
    `| Listing baseline | ${report.listing.state} |`,
    `| Affected listing locales | ${report.listing.affectedLocales?.join(", ") || "not identified"} |`,
    `| Readiness blockers | ${report.blockers.length} |`,
    "",
    "Remote draft existence/version/ZIP hash: unknown. API version equality does not prove draft bytes.",
    "",
    `Listing next action: ${report.listing.nextAction}`,
    "",
    "### Blockers and next action",
    "",
    ...report.blockers.map(
      (b) => `- ${b.code}: ${b.message} Next: ${b.nextAction}`,
    ),
    "",
    `Next action: ${report.nextAction}`,
    "",
    "### Verified receipts",
    "",
    ...report.receipts.map(
      (r) =>
        `- Receipt ${r.runId}: ${r.sourceSha}, ${r.version}, ${r.outcome}; artifact ${r.package.artifactId}; ZIP SHA-256 ${r.package.zipSha256}`,
    ),
    "",
    "Any later mutation requires fresh API/receipt checks, main ancestry, production preflight, release verification and checked packaging.",
    "",
  ].join("\n");
}

function listingNextAction(
  listing: ListingAssessment,
  route: StatusReport["route"],
  blocked: boolean,
): string {
  if (listing.state === "missing" || listing.state === "conflicting") {
    return "Reconcile saved content for the affected locales and record a reviewed baseline; local equality alone is insufficient. Recheck status before any listing edit.";
  }
  if (listing.state === "unchanged") {
    return "Reuse the verified saved-listing baseline; no listing edit or repeated dashboard save is required.";
  }
  const scope = listing.affectedLocales?.length
    ? `changed locales (${listing.affectedLocales.join(", ")})`
    : "changed locales";
  if (route === "reuse-pending") {
    return `Listing updates remain for ${scope}. Wait for the current review to finish without cancelling it, then recheck status and follow separately authorized scoped listing-edit procedures; never reupload the package.`;
  }
  if (route === "reuse-published") {
    return `Listing updates remain for ${scope}. Follow separately authorized scoped listing-edit procedures, record saved/reopened evidence and determine the required listing submission from fresh state; never reupload the published package.`;
  }
  if (blocked) {
    return `Listing updates remain for ${scope}. Resolve the reported blockers and repeat read-only status before selecting a listing-edit or submission procedure.`;
  }
  return `Complete scoped edits for ${scope} through the guarded staged-listing procedure and record saved/reopened evidence before authorized submit-existing; preserve any original uploaded package.`;
}

function readinessBlocker(error: unknown): StatusReport["blockers"][number] {
  return error instanceof ReadinessError
    ? { code: error.code, message: error.message, nextAction: error.nextAction }
    : {
        code: "readiness-unavailable",
        message: "Release readiness could not be established.",
        nextAction:
          "Inspect API and trusted receipts before an explicit recovery decision. Raw errors are suppressed.",
      };
}
