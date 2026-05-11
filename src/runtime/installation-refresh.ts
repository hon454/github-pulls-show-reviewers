import { z } from "zod";

import type { InstallationRefreshOutcome } from "../background/installation-refresh";

const nonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0);

export const refreshAccountInstallationsMessageSchema = z.object({
  type: z.literal("refreshAccountInstallations"),
  accountId: nonEmptyStringSchema,
});

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
