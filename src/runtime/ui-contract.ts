import { z } from "zod";
import {
  preferencePatchSchema,
  preferencesSchema,
} from "../shared/preferences";

export const opaqueIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0);
export const repositoryOwnerSchema = z
  .string()
  .regex(/^[\w-]+$/)
  .max(100);
export const repositoryNameSchema = z
  .string()
  .regex(/^[\w.-]+$/)
  .max(100)
  .refine((value) => value !== "." && value !== "..");
export const repositoryContextSchema = z.strictObject({
  owner: repositoryOwnerSchema,
  repo: repositoryNameSchema,
});

// Deliberately independent of stored Account/auth schemas. Installation owner
// labels support options rendering; repository inventories never enter the UI.
export const accountSummarySchema = z.strictObject({
  id: opaqueIdSchema,
  login: z.string(),
  avatarUrl: z.string().url().nullable(),
  invalidated: z.boolean(),
  invalidatedReason: z
    .enum(["revoked", "expired", "refresh_failed", "unknown"])
    .nullable(),
  revision: opaqueIdSchema,
  installations: z.array(
    z.strictObject({
      id: z.number().int().positive(),
      account: z.strictObject({
        login: z.string(),
        type: z.enum(["User", "Organization"]),
      }),
    }),
  ),
  installationsRefreshedAt: z.number(),
});
export type AccountSummary = z.infer<typeof accountSummarySchema>;

export const uiSnapshotSchema = z.strictObject({
  epoch: opaqueIdSchema,
  revision: z.number().int().nonnegative(),
  accountsRevision: z.string(),
  discoveryRevision: z.string().optional(),
  preferences: preferencesSchema.strict(),
  // Content needs only the opaque account revision. Only options lists accounts.
  accounts: z.array(accountSummarySchema).nullable(),
});
export type UISnapshot = z.infer<typeof uiSnapshotSchema>;
export const UI_STATE_PORT = "ghpsr:ui-state:v1";
export const flowErrorCodeSchema = z.enum([
  "device_flow_disabled",
  "unsupported_grant_type",
  "incorrect_client_credentials",
  "incorrect_device_code",
  "network_error",
  "invalid_response",
  "unknown_error",
  "restart_required",
]);
export const deviceFlowProgressSchema = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("initiating") }),
  z.strictObject({
    phase: z.literal("waiting"),
    flowId: opaqueIdSchema,
    userCode: z.string(),
    verificationUri: z.literal("https://github.com/login/device"),
    verificationUriComplete: z.string().url(),
    interval: z.number().positive(),
    expiresAt: z.number(),
    nextPollAt: z.number(),
  }),
  z.strictObject({ phase: z.literal("fetching_installations") }),
  z.strictObject({ phase: z.literal("committing") }),
  z.strictObject({
    phase: z.literal("connected"),
    account: accountSummarySchema,
  }),
  z.strictObject({ phase: z.literal("cancelled") }),
  z.strictObject({ phase: z.literal("expired") }),
  z.strictObject({ phase: z.literal("denied") }),
  z.strictObject({ phase: z.literal("fatal"), code: flowErrorCodeSchema }),
]);
export type DeviceFlowProgress = z.infer<typeof deviceFlowProgressSchema>;

export const uiStateEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("snapshot"), snapshot: uiSnapshotSchema }),
  z.strictObject({ type: z.literal("unavailable") }),
  z.strictObject({
    type: z.literal("deviceFlow"),
    attemptId: opaqueIdSchema,
    progress: deviceFlowProgressSchema,
  }),
]);

export const uiRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("getUISnapshot") }),
  z.strictObject({
    type: z.literal("patchPreferences"),
    patch: preferencePatchSchema,
  }),
  z.strictObject({
    type: z.literal("resolveAccount"),
    ...repositoryContextSchema.shape,
  }),
  z.strictObject({
    type: z.literal("resolveFallbackAccount"),
    ...repositoryContextSchema.shape,
  }),
  z.strictObject({
    type: z.literal("removeAccount"),
    accountId: opaqueIdSchema,
  }),
  z.strictObject({
    type: z.literal("refreshAccountInstallations"),
    accountId: opaqueIdSchema,
    repository: repositoryContextSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("beginRepositoryDiscovery"),
    pageSession: opaqueIdSchema,
    generation: z.number().int().nonnegative(),
    ...repositoryContextSchema.shape,
  }),
  z.strictObject({
    type: z.literal("retireRepositoryDiscovery"),
    discoveryId: opaqueIdSchema,
  }),
  z.strictObject({
    type: z.literal("diagnoseRepository"),
    mode: z.enum(["matched", "no-token"]),
    runId: opaqueIdSchema.optional(),
    generation: z.number().int().nonnegative().optional(),
    ...repositoryContextSchema.shape,
  }),
  z.strictObject({
    type: z.literal("cancelRepositoryDiagnostic"),
    runId: opaqueIdSchema,
  }),
  z.strictObject({
    type: z.literal("startDeviceFlow"),
    attemptId: opaqueIdSchema,
  }),
  z.strictObject({
    type: z.literal("pollDeviceFlow"),
    attemptId: opaqueIdSchema,
    flowId: opaqueIdSchema,
  }),
  z.strictObject({
    type: z.literal("cancelDeviceFlow"),
    attemptId: opaqueIdSchema,
  }),
]);
export type UIRequest = z.infer<typeof uiRequestSchema>;

export const capabilityFailureSchema = z.strictObject({
  ok: z.literal(false),
  error: z.enum(["forbidden", "invalid-request", "unavailable"]),
});
export type CapabilityFailure = z.infer<typeof capabilityFailureSchema>;
export function capabilityResponseSchema<T extends z.ZodType>(data: T) {
  return z.union([
    z.strictObject({ ok: z.literal(true), data }),
    capabilityFailureSchema,
  ]);
}
