import { accountSummarySchema } from "./ui-contract";
import { getUIClient, requestCapability } from "./ui-client";

export async function listAccounts() {
  const snapshot = await getUIClient().read();
  if (snapshot.accounts == null) throw new Error("accounts_options_only");
  return snapshot.accounts;
}
export function resolveAccountForRepo(owner: string, repo: string) {
  return requestCapability(
    { type: "resolveAccount", owner, repo },
    accountSummarySchema.nullable(),
  );
}
export function resolveFallbackAccount(owner: string, repo: string) {
  return requestCapability(
    { type: "resolveFallbackAccount", owner, repo },
    accountSummarySchema.nullable(),
  );
}
