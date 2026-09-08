import { z } from "zod";
import type { RefreshOutcome } from "../auth/refresh-coordinator";
import { credentialGeneration, type Account } from "../storage/accounts";

export const accountAuthMessageSchema = z.strictObject({
  type: z.enum(["refreshAccessToken", "invalidateAccessToken"]),
  accountId: z.string().trim().min(1),
  generation: z.string().trim().min(1),
});

export async function recoverAccountToken(
  account: Account,
): Promise<RefreshOutcome | undefined> {
  return browser.runtime.sendMessage({
    type: "refreshAccessToken",
    accountId: account.id,
    generation: credentialGeneration(account),
  });
}

export async function invalidateAccountToken(account: Account): Promise<void> {
  await browser.runtime.sendMessage({
    type: "invalidateAccessToken",
    accountId: account.id,
    generation: credentialGeneration(account),
  });
}
