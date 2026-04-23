import {
  extractGitHubApiStatus,
  validateGitHubRepositoryAccess,
  type RepositoryValidationResult,
} from "../github/api";
import {
  getAccountById,
  markAccountInvalidated,
  type Account,
} from "../storage/accounts";

export async function validateRepositoryAccessWithAccount(input: {
  account: Account;
  repository: string;
}): Promise<RepositoryValidationResult> {
  const { account, repository } = input;
  const first = await validateGitHubRepositoryAccess(account, repository);

  if (first.ok || first.outcome !== "token-invalid") {
    return first;
  }

  if (account.refreshToken == null) {
    await markAccountInvalidated(account.id, "revoked");
    return first;
  }

  const outcome = (await browser.runtime.sendMessage({
    type: "refreshAccessToken",
    accountId: account.id,
  })) as
    | { ok: true; token: string }
    | { ok: false; terminal: boolean }
    | undefined;

  if (!outcome || outcome.ok !== true) {
    return first;
  }

  const refreshed = (await getAccountById(account.id)) ?? {
    ...account,
    token: outcome.token,
  };
  const retry = await validateGitHubRepositoryAccess(refreshed, repository);
  if (!retry.ok && retry.outcome === "token-invalid") {
    await markAccountInvalidated(account.id, "revoked");
  }
  return retry;
}

export async function retryWithAccountRefresh<T>(input: {
  account: Account | null;
  execute: (token: string | null) => Promise<T>;
}): Promise<T> {
  const { account, execute } = input;

  try {
    return await execute(account?.token ?? null);
  } catch (error) {
    if (extractGitHubApiStatus(error) !== 401 || account == null) {
      throw error;
    }

    if (account.refreshToken == null) {
      await markAccountInvalidated(account.id, "revoked");
      throw error;
    }

    const outcome = (await browser.runtime.sendMessage({
      type: "refreshAccessToken",
      accountId: account.id,
    })) as
      | { ok: true; token: string }
      | { ok: false; terminal: boolean }
      | undefined;

    if (!outcome || outcome.ok !== true) {
      throw error;
    }

    const refreshed = await getAccountById(account.id);
    try {
      return await execute(refreshed?.token ?? outcome.token);
    } catch (retryError) {
      if (extractGitHubApiStatus(retryError) === 401) {
        await markAccountInvalidated(account.id, "revoked");
      }
      throw retryError;
    }
  }
}
