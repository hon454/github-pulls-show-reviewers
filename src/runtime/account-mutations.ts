import { z } from "zod";
import {
  installationSchema,
  type Account,
  type AccountConnectInput,
} from "../storage/accounts";

const nonEmptyString = z.string().trim().min(1);
const connectInputSchema = z.strictObject({
  login: nonEmptyString,
  avatarUrl: z.string().url().nullable(),
  token: z.string().min(1),
  refreshToken: z.string().nullable(),
  expiresAt: z.number().nullable(),
  refreshTokenExpiresAt: z.number().nullable(),
  installations: z.array(installationSchema),
  newAccountId: nonEmptyString,
  now: z.number(),
});

export const accountMutationMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("upsertAccountByLogin"),
    input: connectInputSchema,
  }),
  z.strictObject({
    type: z.literal("removeAccount"),
    accountId: nonEmptyString,
  }),
]);
export type AccountMutationMessage = z.infer<
  typeof accountMutationMessageSchema
>;
export type AccountMutationResponse =
  | { ok: true; account?: Account }
  | { ok: false };

/** Options commit/removal entrypoints; all writes execute in the background. */
export async function upsertAccountByLogin(
  input: AccountConnectInput,
): Promise<Account> {
  const result = (await browser.runtime.sendMessage({
    type: "upsertAccountByLogin",
    input,
  })) as AccountMutationResponse | undefined;
  if (!result?.ok || !result.account) throw new Error("account_commit_failed");
  return result.account;
}

export async function removeAccount(accountId: string): Promise<void> {
  const result = (await browser.runtime.sendMessage({
    type: "removeAccount",
    accountId,
  })) as AccountMutationResponse | undefined;
  if (!result?.ok) throw new Error("account_remove_failed");
}
