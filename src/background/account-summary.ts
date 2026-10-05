import {
  accountSummarySchema,
  contentAccountSchema,
  type AccountSummary,
  type ContentAccount,
} from "../runtime/ui-contract";
import { credentialGeneration, type Account } from "../storage/accounts";

/** Explicit projection, including nested objects. Never forward stored records. */
export function summarizeAccount(account: Account): AccountSummary {
  return accountSummarySchema.parse({
    id: account.id,
    login: account.login,
    avatarUrl: account.avatarUrl,
    invalidated: account.invalidated,
    invalidatedReason: account.invalidatedReason,
    revision: credentialGeneration(account),
    installations: account.installations.map((installation) => ({
      id: installation.id,
      account: {
        login: installation.account.login,
        type: installation.account.type,
      },
    })),
    installationsRefreshedAt: account.installationsRefreshedAt,
  });
}

/**
 * The only account data a content document receives. A github.com renderer
 * must not learn the extension account's login, avatar or installation owners.
 */
export function projectContentAccount(
  account: Pick<AccountSummary, "id" | "revision" | "invalidated">,
): ContentAccount {
  return contentAccountSchema.parse({
    id: account.id,
    revision: account.revision,
    invalidated: account.invalidated,
  });
}
