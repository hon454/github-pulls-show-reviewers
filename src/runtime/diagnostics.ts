import { z } from "zod";
import { requestCapability } from "./ui-client";

// These are display facts, never API error prose, request objects or headers.
export const rateLimitSnapshotSchema = z.object({
  limit: z.number().nullable(),
  remaining: z.number().nullable(),
  resource: z.string().nullable(),
  resetAt: z.number().nullable(),
});
const endpointSchema = z.object({
  name: z.enum(["pull", "reviews", "issue-events", "pulls-list"]),
  method: z.literal("GET"),
  path: z.string(),
});
export const diagnosticFailureSchema = z.object({
  kind: z.enum(["http", "schema", "network", "cancellation", "unknown"]),
  endpoint: endpointSchema.optional(),
  httpStatus: z.number().optional(),
  rateLimit: rateLimitSnapshotSchema.optional(),
  rateLimited: z.boolean().optional(),
});
export type RepositoryDiagnosticFailure = z.infer<
  typeof diagnosticFailureSchema
>;
const evidence = {
  failures: z.array(diagnosticFailureSchema).optional(),
  endpoint: endpointSchema.optional(),
  httpStatus: z.number().optional(),
  rateLimit: rateLimitSnapshotSchema.optional(),
};
export const repositoryValidationSummarySchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    authMode: z.enum(["token", "no-token"]),
    outcome: z.literal("accessible"),
    fullName: z.string(),
    pullNumber: z.string(),
    ...evidence,
  }),
  z.object({
    ok: z.literal(false),
    authMode: z.enum(["token", "no-token"]),
    outcome: z.enum([
      "invalid-repository",
      "no-pulls",
      "authenticated-rate-limit",
      "unauthenticated-rate-limit",
      "unauthenticated-private-like",
      "token-invalid",
      "token-permission",
      "token-not-found",
      "unknown-error",
    ]),
    fullName: z.string().optional(),
    pullNumber: z.string().optional(),
    ...evidence,
  }),
]);
export type RepositoryValidationSummary = z.infer<
  typeof repositoryValidationSummarySchema
>;
export const repositoryDiagnosticSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncovered"), repository: z.string() }),
  z.object({
    kind: z.literal("failed"),
    failures: z.array(diagnosticFailureSchema),
  }),
  z.object({
    kind: z.literal("matched"),
    repository: z.string(),
    coverageStatus: z.enum(["covered", "maybe-covered-truncated"]),
    account: z.object({ login: z.string() }),
    result: repositoryValidationSummarySchema,
  }),
  z.object({
    kind: z.literal("no-token"),
    repository: z.string(),
    result: repositoryValidationSummarySchema,
  }),
]);
export function diagnoseRepository(
  owner: string,
  repo: string,
  mode: "matched" | "no-token",
  signal?: AbortSignal,
) {
  if (signal?.aborted)
    return Promise.reject(
      new DOMException("Diagnostic canceled", "AbortError"),
    );
  const runId = crypto.randomUUID();
  const generation = ++diagnosticGeneration;
  const work = requestCapability(
    { type: "diagnoseRepository", owner, repo, mode, runId, generation },
    repositoryDiagnosticSchema,
  );
  if (!signal) return work;
  return new Promise<z.infer<typeof repositoryDiagnosticSchema>>(
    (resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        void requestCapability(
          { type: "cancelRepositoryDiagnostic", runId },
          z.null(),
        ).catch(() => undefined);
        reject(new DOMException("Diagnostic canceled", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      work.then(
        (result) => {
          signal.removeEventListener("abort", abort);
          if (!signal.aborted) resolve(result);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    },
  );
}
let diagnosticGeneration = 0;
