import { z } from "zod";

export class ReleaseError extends Error {}
export class ReadinessError extends ReleaseError {
  readonly code: string;
  readonly nextAction: string;
  constructor(code: string, message: string, nextAction: string) {
    super(message);
    this.code = code;
    this.nextAction = nextAction;
  }
}
export function requireReadiness(
  value: unknown,
  code: string,
  message: string,
  nextAction: string,
): asserts value {
  if (!value) throw new ReadinessError(code, message, nextAction);
}

export function requireCondition(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new ReleaseError(message);
}

export function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  requireCondition(
    result.success,
    `Invalid ${label}; inspect the documented schema.`,
  );
  return result.data;
}

export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:\.\d+)?$/);
const idSchema = z.string().regex(/^[1-9]\d*$/);
export const actionSchema = z.enum([
  "skip",
  "dry-run",
  "status",
  "publish",
  "upload-only",
  "submit-existing",
]);
export type Action = z.infer<typeof actionSchema>;

export function resolveAction(input: {
  event: string;
  ref: string;
  action?: string;
  tag?: string;
  sourceSha?: string;
  expectedVersion?: string;
  receiptRunId?: string;
}) {
  const tag =
    input.tag ||
    (input.ref.startsWith("refs/tags/") ? input.ref.slice(10) : "");
  if (tag)
    requireCondition(
      /^v\d+\.\d+\.\d+(?:\.\d+)?$/.test(tag),
      "Only existing version tags are supported.",
    );
  if (input.event === "push") {
    requireCondition(
      input.ref.startsWith("refs/tags/v") &&
        tag &&
        !input.action &&
        !input.sourceSha &&
        !input.receiptRunId,
      "Only version-tag pushes may trigger automatic publishing.",
    );
    return {
      action: "publish" as Action,
      sourceRef: input.ref,
      tag,
      createRelease: true,
    };
  }
  requireCondition(
    input.event === "workflow_dispatch",
    "Unsupported release event.",
  );
  const action = parse(actionSchema, input.action || "skip", "release action");
  const staging = action === "upload-only" || action === "submit-existing";
  if (action === "status") {
    requireCondition(
      !input.tag,
      "Status uses source SHA/version inputs, not a tag input.",
    );
    parse(shaSchema, input.sourceSha, "status source SHA");
    parse(versionSchema, input.expectedVersion, "status expected version");
    if (input.receiptRunId)
      parse(idSchema, input.receiptRunId, "upload receipt run ID");
  } else if (staging) {
    requireCondition(
      !input.tag,
      "Staging actions must not target a release tag input.",
    );
    parse(shaSchema, input.sourceSha, "release source SHA");
    parse(versionSchema, input.expectedVersion, "expected version");
    if (action === "submit-existing")
      parse(idSchema, input.receiptRunId, "upload receipt run ID");
    else
      requireCondition(
        !input.receiptRunId,
        "upload-only does not accept a receipt run ID.",
      );
  } else {
    requireCondition(
      !input.sourceSha && !input.receiptRunId,
      "Source SHA and receipt inputs are only supported by staging actions.",
    );
  }
  return {
    action,
    sourceRef:
      staging || action === "status"
        ? input.sourceSha!
        : input.tag || input.ref,
    tag: staging || action === "dry-run" || action === "status" ? "" : tag,
    createRelease:
      !staging && action !== "dry-run" && action !== "status" && Boolean(tag),
  };
}

const revisionSchema = z.object({
  state: z.enum([
    "ITEM_STATE_UNSPECIFIED",
    "PENDING_REVIEW",
    "STAGED",
    "PUBLISHED",
    "PUBLISHED_TO_TESTERS",
    "REJECTED",
    "CANCELLED",
  ]),
  distributionChannels: z.array(z.object({ crxVersion: versionSchema })).min(1),
});
export const statusSchema = z.object({
  name: z.string(),
  itemId: z.string(),
  publishedItemRevisionStatus: revisionSchema.optional(),
  submittedItemRevisionStatus: revisionSchema.optional(),
  lastAsyncUploadState: z
    .enum([
      "UPLOAD_STATE_UNSPECIFIED",
      "SUCCEEDED",
      "IN_PROGRESS",
      "FAILED",
      "NOT_FOUND",
    ])
    .optional(),
  takenDown: z.boolean().optional(),
  warned: z.boolean().optional(),
});
export type StoreStatus = z.infer<typeof statusSchema>;

export function inspectStatus(
  raw: unknown,
  item: { publisherId: string; itemId: string },
  version: string,
) {
  const status = parse(statusSchema, raw, "CWS status");
  requireReadiness(
    status.name === `publishers/${item.publisherId}/items/${item.itemId}` &&
      status.itemId === item.itemId,
    "item-identity",
    "CWS item identity mismatch.",
    "Check the configured publisher/item against the API and trusted receipts.",
  );
  requireReadiness(
    !status.takenDown && !status.warned,
    "policy-warning",
    "CWS policy state requires an explicit recovery decision.",
    "Inspect the specific warning/takedown details in the dashboard, then obtain an explicit recovery decision.",
  );
  requireReadiness(
    !status.lastAsyncUploadState || status.lastAsyncUploadState === "SUCCEEDED",
    "async-upload",
    "Async upload state is uncertain or unsuccessful; inspect API status and receipts without retrying writes.",
    "Wait and repeat API status/receipt observation. Failed or unresolvable uploads require an explicit recovery decision; never reupload blindly.",
  );
  const submitted = status.submittedItemRevisionStatus;
  if (submitted) {
    requireReadiness(
      submitted.state === "PENDING_REVIEW",
      "submitted-state",
      "Submitted revision requires an explicit recovery decision.",
      "Preserve the API revision state; obtain an explicit recovery decision before another write.",
    );
    requireReadiness(
      submitted.distributionChannels.every((c) => c.crxVersion === version),
      "pending-conflict",
      "A conflicting version is pending review.",
      "Wait for the other version and observe API status; do not cancel its review.",
    );
    return "pending" as const;
  }
  const published = status.publishedItemRevisionStatus;
  if (published) {
    requireReadiness(
      published.state === "PUBLISHED",
      "published-state",
      "Unexpected published revision state.",
      "Inspect API/receipt state and obtain an explicit recovery decision.",
    );
    if (published.distributionChannels.every((c) => c.crxVersion === version))
      return "published" as const;
    requireReadiness(
      published.distributionChannels.every(
        (c) => compareVersions(c.crxVersion, version) < 0,
      ),
      "published-conflict",
      "Published version conflicts with the expected release.",
      "Check the selected source/version against API publication and receipt history; decide the correct release version.",
    );
  }
  return "draft" as const;
}

export function compareVersions(a: string, b: string) {
  const aa = a.split(".").map(Number),
    bb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++)
    if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) - (bb[i] || 0);
  return 0;
}

export const receiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  workflowPath: z.literal(".github/workflows/release.yml"),
  workflowSha: shaSchema,
  runId: idSchema,
  runAttempt: z.literal("1"),
  runUrl: z.url(),
  sourceSha: shaSchema,
  version: versionSchema,
  publisherId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  itemId: z.string().regex(/^[a-p]{32}$/),
  action: actionSchema,
  checked: z.literal(true),
  timestamp: z.iso.datetime(),
  package: z.strictObject({
    artifactId: idSchema,
    artifactName: z.string().regex(/^chrome-package-\d+$/),
    artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    zipName: z
      .string()
      .regex(
        /^github-pulls-show-reviewers-\d+\.\d+\.\d+(?:\.\d+)?-chrome\.zip$/,
      ),
    zipSha256: hashSchema,
  }),
  priorReceiptRunId: idSchema.optional(),
  upload: z.enum(["NOT_ATTEMPTED", "SUCCEEDED", "IN_PROGRESS", "UNKNOWN"]),
  submission: z.enum(["NOT_ATTEMPTED", "CONFIRMED", "UNKNOWN"]),
  outcome: z.enum([
    "INTENT",
    "UPLOADED",
    "SUBMITTED",
    "ALREADY_PENDING",
    "ALREADY_PUBLISHED",
    "STOPPED",
    "UNCERTAIN",
  ]),
  mutationStarted: z.boolean(),
});
export type Receipt = z.infer<typeof receiptSchema>;

export function validateReceipt(
  raw: unknown,
  expected: {
    repository: string;
    sourceSha: string;
    version: string;
    publisherId: string;
    itemId: string;
  },
) {
  const receipt = parse(receiptSchema, raw, "upload receipt");
  for (const key of [
    "repository",
    "sourceSha",
    "version",
    "publisherId",
    "itemId",
  ] as const)
    requireCondition(
      receipt[key] === expected[key],
      `Receipt ${key} mismatch.`,
    );
  requireCondition(
    receipt.runUrl ===
      `https://github.com/${receipt.repository}/actions/runs/${receipt.runId}`,
    "Receipt run URL mismatch.",
  );
  requireCondition(
    receipt.package.artifactName === `chrome-package-${receipt.runId}`,
    "Receipt package artifact name mismatch.",
  );
  requireCondition(
    receipt.package.zipName ===
      `github-pulls-show-reviewers-${receipt.version}-chrome.zip`,
    "Receipt package version mismatch.",
  );
  return receipt;
}

export const evidenceSchema = z.strictObject({
  receiptRunId: idSchema,
  sourceSha: shaSchema,
  zipSha256: hashSchema,
  itemId: z.string(),
  version: versionSchema,
  observedAt: z.iso.datetime(),
  evidenceUrl: z.url(),
  listingReady: z.literal(true),
  noInterveningUpload: z.literal(true),
  draftVersionVerified: z.literal(true),
  asyncUploadConfirmed: z.literal(true).optional(),
  locales: z.array(z.string()).length(5),
});
export type ListingEvidence = z.infer<typeof evidenceSchema>;

export function validateEvidence(
  raw: unknown,
  receipt: Receipt,
  now = Date.now(),
) {
  const evidence = parse(
    evidenceSchema,
    raw,
    "listing-ready dashboard evidence",
  );
  requireCondition(
    evidence.receiptRunId === receipt.runId &&
      evidence.sourceSha === receipt.sourceSha &&
      evidence.zipSha256 === receipt.package.zipSha256 &&
      evidence.itemId === receipt.itemId &&
      evidence.version === receipt.version,
    "Listing-ready evidence does not identify this upload receipt.",
  );
  const age = now - Date.parse(evidence.observedAt);
  requireCondition(
    age >= 0 &&
      age <= 60 * 60 * 1000 &&
      Date.parse(evidence.observedAt) >= Date.parse(receipt.timestamp),
    "Dashboard evidence must be refreshed within one hour of submission and after the upload.",
  );
  requireCondition(
    [...evidence.locales].sort().join(",") === "en,ja,ko,zh_CN,zh_TW",
    "Verify exactly en, ko, ja, zh_CN and zh_TW listing locales.",
  );
  const url = new URL(evidence.evidenceUrl);
  requireCondition(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      url.hostname === "github.com" &&
      url.pathname.startsWith(`/${receipt.repository}/`),
    "Evidence must be a credential-free permalink in this repository.",
  );
  return evidence;
}
