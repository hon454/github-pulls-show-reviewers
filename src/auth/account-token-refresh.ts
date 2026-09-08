import {
  extractGitHubApiStatus,
  validateGitHubRepositoryAccess,
  type RepositoryValidationResult,
} from "../github/api";
import {
  accountMutations,
  credentialGeneration,
  type Account,
} from "../storage/accounts";
import type { RefreshCoordinator } from "./refresh-coordinator";
export async function validateRepositoryAccessWithAccount(input: {
  account: Account;
  repository: string;
  coordinator: RefreshCoordinator;
}): Promise<RepositoryValidationResult> {
  const { account, repository } = input;
  const first = await validateGitHubRepositoryAccess(account, repository);

  if (first.ok || first.outcome !== "token-invalid") {
    return first;
  }

  const outcome = await input.coordinator.refreshAccountToken(
    account.id,
    credentialGeneration(account),
  );

  if (!outcome || outcome.ok !== true) {
    return first;
  }

  const refreshed = await accountMutations.getAccountById(account.id);
  if (refreshed == null || refreshed.invalidated) return first;
  const retry = await validateGitHubRepositoryAccess(refreshed, repository);
  if (!retry.ok && retry.outcome === "token-invalid") {
    await input.coordinator.invalidateAccountToken(
      refreshed.id,
      credentialGeneration(refreshed),
    );
  }
  return retry;
}

export async function retryWithAccountRefresh<T>(input: {
  account: Account | null;
  execute: (token: string | null) => Promise<T>;
  coordinator: RefreshCoordinator;
}): Promise<T> {
  const { account, execute } = input;

  try {
    return await execute(account?.token ?? null);
  } catch (error) {
    if (extractGitHubApiStatus(error) !== 401 || account == null) {
      throw error;
    }

    const outcome = await input.coordinator.refreshAccountToken(
      account.id,
      credentialGeneration(account),
    );

    if (!outcome || outcome.ok !== true) {
      throw error;
    }

    const refreshed = await accountMutations.getAccountById(account.id);
    if (refreshed == null || refreshed.invalidated) throw error;
    try {
      return await execute(refreshed.token);
    } catch (retryError) {
      if (extractGitHubApiStatus(retryError) === 401) {
        await input.coordinator.invalidateAccountToken(
          refreshed.id,
          credentialGeneration(refreshed),
        );
      }
      throw retryError;
    }
  }
}
