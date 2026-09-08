import { z } from "zod";
import { repositoryOwnerSchema, repositoryNameSchema } from "./ui-contract";
import { rateLimitSnapshotSchema } from "./diagnostics";

import {
  GitHubApiError,
  GitHubApiSchemaError,
  GitHubPullRequestEndpointsError,
  extractGitHubApiStatus,
  isRateLimitError,
  type PullReviewerMetadata,
  type PullReviewerSummary,
} from "../github/api";

const nonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0);

const reviewerUserMessageSchema = z.object({
  login: nonEmptyStringSchema,
  avatarUrl: z.string().nullable(),
}) satisfies z.ZodType<PullReviewerMetadata["requestedUsers"][number]>;

const pullReviewerMetadataMessageSchema = z.object({
  number: nonEmptyStringSchema,
  authorLogin: nonEmptyStringSchema,
  requestedUsers: z.array(reviewerUserMessageSchema),
  requestedTeams: z.array(z.string()),
}) satisfies z.ZodType<PullReviewerMetadata>;

export const fetchPullReviewerSummaryMessageSchema = z.strictObject({
  type: z.literal("fetchPullReviewerSummary"),
  requestId: nonEmptyStringSchema,
  owner: repositoryOwnerSchema,
  repo: repositoryNameSchema,
  pullNumber: z.string().regex(/^[1-9]\d*$/),
  accountId: z.string().nullable(),
  pullMetadata: pullReviewerMetadataMessageSchema.optional(),
});

export type FetchPullReviewerSummaryMessage = z.infer<
  typeof fetchPullReviewerSummaryMessageSchema
>;

export const cancelPullReviewerSummaryMessageSchema = z.strictObject({
  type: z.literal("cancelPullReviewerSummary"),
  requestId: nonEmptyStringSchema,
});

export type CancelPullReviewerSummaryMessage = z.infer<
  typeof cancelPullReviewerSummaryMessageSchema
>;

export const fetchPullReviewerMetadataBatchMessageSchema = z.strictObject({
  type: z.literal("fetchPullReviewerMetadataBatch"),
  requestId: nonEmptyStringSchema,
  owner: repositoryOwnerSchema,
  repo: repositoryNameSchema,
  accountId: z.string().nullable(),
  targetPullNumbers: z.array(nonEmptyStringSchema).optional(),
});

export type FetchPullReviewerMetadataBatchMessage = z.infer<
  typeof fetchPullReviewerMetadataBatchMessageSchema
>;

export type ReviewerFetchRateLimitSnapshot = {
  limit: number | null;
  remaining: number | null;
  resource: string | null;
  resetAt: number | null;
};

export type ReviewerFetchFailure = {
  status: number;
  endpoint: string | null;
  rateLimited: boolean;
  rateLimit?: ReviewerFetchRateLimitSnapshot | undefined;
};

export type ReviewerFetchErrorEnvelope = {
  kind: "github-api" | "github-endpoints" | "schema" | "unknown";
  status: number | null;
  failures?: ReviewerFetchFailure[] | undefined;
};

export type FetchPullReviewerSummaryResponse =
  | {
      ok: true;
      summary: PullReviewerSummary;
    }
  | {
      ok: false;
      error: ReviewerFetchErrorEnvelope;
    };

export type FetchPullReviewerMetadataBatchResponse =
  | {
      ok: true;
      metadata: PullReviewerMetadata[];
    }
  | {
      ok: false;
      error: ReviewerFetchErrorEnvelope;
    };

export const reviewerFetchErrorSchema = z.object({
  kind: z.enum(["github-api", "github-endpoints", "schema", "unknown"]),
  status: z.number().nullable(),
  failures: z
    .array(
      z.object({
        status: z.number(),
        endpoint: z.string().nullable(),
        rateLimited: z.boolean(),
        rateLimit: rateLimitSnapshotSchema.optional(),
      }),
    )
    .optional(),
});
const pullReviewerSummarySchema = z.object({
  status: z.enum(["ok", "no-coverage", "network-error", "rate-limited"]),
  requestedUsers: z.array(reviewerUserMessageSchema),
  requestedTeams: z.array(z.string()),
  completedReviews: z.array(
    reviewerUserMessageSchema.extend({
      state: z.enum([
        "APPROVED",
        "CHANGES_REQUESTED",
        "COMMENTED",
        "DISMISSED",
      ]),
    }),
  ),
});
export const fetchPullReviewerSummaryResponseSchema = z.discriminatedUnion(
  "ok",
  [
    z.object({ ok: z.literal(true), summary: pullReviewerSummarySchema }),
    z.object({ ok: z.literal(false), error: reviewerFetchErrorSchema }),
  ],
);
export const fetchPullReviewerMetadataBatchResponseSchema =
  z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      metadata: z.array(pullReviewerMetadataMessageSchema),
    }),
    z.object({ ok: z.literal(false), error: reviewerFetchErrorSchema }),
  ]);

export class ReviewerFetchRuntimeError extends Error {
  constructor(public readonly envelope: ReviewerFetchErrorEnvelope) {
    super("Background reviewer fetch failed.");
    this.name = "ReviewerFetchRuntimeError";
  }
}

export function isFetchPullReviewerSummaryMessage(
  value: unknown,
): value is FetchPullReviewerSummaryMessage {
  return fetchPullReviewerSummaryMessageSchema.safeParse(value).success;
}

export function isCancelPullReviewerSummaryMessage(
  value: unknown,
): value is CancelPullReviewerSummaryMessage {
  return cancelPullReviewerSummaryMessageSchema.safeParse(value).success;
}

export function isFetchPullReviewerMetadataBatchMessage(
  value: unknown,
): value is FetchPullReviewerMetadataBatchMessage {
  return fetchPullReviewerMetadataBatchMessageSchema.safeParse(value).success;
}

export function serializeReviewerFetchError(
  error: unknown,
): ReviewerFetchErrorEnvelope {
  if (error instanceof GitHubPullRequestEndpointsError) {
    return {
      kind: "github-endpoints",
      status: extractGitHubApiStatus(error),
      failures: error.failures.map(toReviewerFetchFailure),
    };
  }

  if (error instanceof GitHubApiError) {
    return {
      kind: "github-api",
      status: error.status,
      failures: [toReviewerFetchFailure(error)],
    };
  }

  if (error instanceof GitHubApiSchemaError) {
    return {
      kind: "schema",
      status: null,
    };
  }

  if (error instanceof Error) {
    return {
      kind: "unknown",
      status: extractGitHubApiStatus(error),
    };
  }

  return {
    kind: "unknown",
    status: extractGitHubApiStatus(error),
  };
}

export function extractReviewerFetchFailures(
  error: unknown,
): ReviewerFetchFailure[] {
  if (error instanceof ReviewerFetchRuntimeError) {
    return extractReviewerFetchFailures(error.envelope);
  }

  if (error instanceof GitHubPullRequestEndpointsError) {
    return error.failures.map(toReviewerFetchFailure);
  }

  if (error instanceof GitHubApiError) {
    return [toReviewerFetchFailure(error)];
  }

  if (
    error != null &&
    typeof error === "object" &&
    "failures" in error &&
    Array.isArray((error as { failures: unknown }).failures)
  ) {
    return (
      error as {
        failures: Array<{
          status?: unknown;
          endpoint?: unknown;
          rateLimited?: unknown;
          rateLimit?: unknown;
        }>;
      }
    ).failures
      .filter(
        (
          failure,
        ): failure is {
          status: number;
          endpoint?: string | null;
          rateLimited?: boolean;
          rateLimit?: unknown;
        } => typeof failure?.status === "number",
      )
      .map((failure) => {
        const base: ReviewerFetchFailure = {
          status: failure.status,
          endpoint:
            typeof failure.endpoint === "string" ? failure.endpoint : null,
          rateLimited: failure.rateLimited === true,
        };
        const rateLimit = parseRateLimitSnapshot(failure.rateLimit);
        return rateLimit == null ? base : { ...base, rateLimit };
      });
  }

  if (
    error != null &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    return [
      {
        status: (error as { status: number }).status,
        endpoint: null,
        rateLimited: false,
      },
    ];
  }

  return [];
}

function toReviewerFetchFailure(failure: GitHubApiError): ReviewerFetchFailure {
  const base: ReviewerFetchFailure = {
    status: failure.status,
    endpoint: failure.endpoint?.path ?? null,
    rateLimited: isRateLimitError(failure),
  };
  const rateLimit = readGitHubApiErrorRateLimit(failure);
  return rateLimit == null ? base : { ...base, rateLimit };
}

function readGitHubApiErrorRateLimit(
  failure: GitHubApiError,
): ReviewerFetchRateLimitSnapshot | undefined {
  const snapshot = failure.rateLimit;
  if (snapshot == null) {
    return undefined;
  }
  if (
    snapshot.limit == null &&
    snapshot.remaining == null &&
    snapshot.resource == null &&
    snapshot.resetAt == null
  ) {
    return undefined;
  }
  return {
    limit: snapshot.limit,
    remaining: snapshot.remaining,
    resource: snapshot.resource,
    resetAt: snapshot.resetAt,
  };
}

function parseRateLimitSnapshot(
  value: unknown,
): ReviewerFetchRateLimitSnapshot | undefined {
  if (value == null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const candidate: ReviewerFetchRateLimitSnapshot = {
    limit: typeof record.limit === "number" ? record.limit : null,
    remaining: typeof record.remaining === "number" ? record.remaining : null,
    resource: typeof record.resource === "string" ? record.resource : null,
    resetAt: typeof record.resetAt === "number" ? record.resetAt : null,
  };
  if (
    candidate.limit == null &&
    candidate.remaining == null &&
    candidate.resource == null &&
    candidate.resetAt == null
  ) {
    return undefined;
  }
  return candidate;
}
