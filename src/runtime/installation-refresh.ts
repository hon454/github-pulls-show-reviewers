import { z } from "zod";
import { requestCapability } from "./ui-client";
import { repositoryContextSchema } from "./ui-contract";

import type { InstallationRefreshOutcome } from "../background/installation-refresh";

const nonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0);

export const refreshAccountInstallationsMessageSchema = z.strictObject({
  type: z.literal("refreshAccountInstallations"),
  accountId: nonEmptyStringSchema,
  repository: repositoryContextSchema.optional(),
});

export const installationRefreshOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["no-account", "invalidated", "failed"]),
  }),
]);
export function refreshAccountInstallations(
  accountId: string,
  repository?: { owner: string; repo: string },
) {
  return requestCapability(
    {
      type: "refreshAccountInstallations",
      accountId,
      ...(repository ? { repository } : {}),
    },
    installationRefreshOutcomeSchema,
  );
}

export type RefreshAccountInstallationsMessage = z.infer<
  typeof refreshAccountInstallationsMessageSchema
>;

export type RefreshAccountInstallationsResponse =
  | InstallationRefreshOutcome
  | undefined;

export function isRefreshAccountInstallationsMessage(
  value: unknown,
): value is RefreshAccountInstallationsMessage {
  return refreshAccountInstallationsMessageSchema.safeParse(value).success;
}
