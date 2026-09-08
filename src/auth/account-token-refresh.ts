import {
  extractGitHubApiStatus,
  validateGitHubRepositoryAccess,
  type RepositoryValidationResult,
} from "../github/api";
import { getAccountById, type Account } from "../storage/accounts";
import {
  recoverAccountToken,
  invalidateAccountToken,
} from "../runtime/account-auth";

export async function validateRepositoryAccessWithAccount(input: {
  account: Account;
  repository: string;
}): Promise<RepositoryValidationResult> {
  const { account, repository } = input;
  const first = await validateGitHubRepositoryAccess(account, repository);

  if (first.ok || first.outcome !== "token-invalid") {
    return first;
  }

  const outcome = await recoverAccountToken(account);

  if (!outcome || outcome.ok !== true) {
    return first;
  }

  const refreshed = await getAccountById(account.id);
  if (refreshed == null || refreshed.invalidated) return first;
  const retry = await validateGitHubRepositoryAccess(refreshed, repository);
  if (!retry.ok && retry.outcome === "token-invalid") {
    await invalidateAccountToken(refreshed);
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

    const outcome = await recoverAccountToken(account);

    if (!outcome || outcome.ok !== true) {
      throw error;
    }

    const refreshed = await getAccountById(account.id);
    if (refreshed == null || refreshed.invalidated) throw error;
    try {
      return await execute(refreshed.token);
    } catch (retryError) {
      if (extractGitHubApiStatus(retryError) === 401) {
        await invalidateAccountToken(refreshed);
      }
      throw retryError;
    }
  }
}
