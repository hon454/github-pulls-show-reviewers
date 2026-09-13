import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import { extractGitHubApiStatus } from "../github/api";
import { loadAccountInstallations } from "../github/installations";
import {
  accountMutations,
  credentialGeneration,
  type Account,
} from "../storage/accounts";

export type InstallationRefreshOutcome =
  | { ok: true }
  | { ok: false; reason: "no-account" | "invalidated" | "failed" };

export type InstallationRefreshService = {
  refreshAccountInstallations(
    accountId: string,
  ): Promise<InstallationRefreshOutcome>;
};

export function createInstallationRefreshService(input: {
  refreshCoordinator: RefreshCoordinator;
}): InstallationRefreshService {
  const { refreshCoordinator } = input;
  const inFlight = new Map<
    string,
    { generation: string; promise: Promise<InstallationRefreshOutcome> }
  >();

  async function run(account: Account): Promise<InstallationRefreshOutcome> {
    try {
      const installations = await loadAccountInstallations({
        token: account.token,
      });
      const commit = await accountMutations.replaceInstallations(
        account.id,
        installations,
        credentialGeneration(account),
      );
      return commit === "committed"
        ? { ok: true }
        : { ok: false, reason: "failed" };
    } catch (error) {
      if (extractGitHubApiStatus(error) !== 401) {
        return { ok: false, reason: "failed" };
      }

      const refreshOutcome = await refreshCoordinator.refreshAccountToken(
        account.id,
        credentialGeneration(account),
      );
      if (!refreshOutcome.ok) {
        return { ok: false, reason: "failed" };
      }

      const refreshed: Account | null = await accountMutations.getAccountById(
        account.id,
      );
      if (refreshed == null || refreshed.invalidated)
        return { ok: false, reason: "no-account" };
      const tokenForRetry = refreshed.token;
      try {
        const installations = await loadAccountInstallations({
          token: tokenForRetry,
        });
        const commit = await accountMutations.replaceInstallations(
          account.id,
          installations,
          credentialGeneration(refreshed),
        );
        return commit === "committed"
          ? { ok: true }
          : { ok: false, reason: "failed" };
      } catch (retryError) {
        if (extractGitHubApiStatus(retryError) === 401) {
          await refreshCoordinator.invalidateAccountToken(
            account.id,
            credentialGeneration(refreshed),
          );
        }
        return { ok: false, reason: "failed" };
      }
    }
  }

  return {
    async refreshAccountInstallations(
      accountId: string,
    ): Promise<InstallationRefreshOutcome> {
      // The owner serializes this admission read with sign-in and token
      // rotation. A later generation must not join an earlier HTTP request.
      const account = await accountMutations.getAccountById(accountId);
      if (account == null) return { ok: false, reason: "no-account" };
      if (account.invalidated) return { ok: false, reason: "invalidated" };
      const generation = credentialGeneration(account);
      const existing = inFlight.get(accountId);
      if (existing?.generation === generation) {
        return existing.promise;
      }
      const promise = run(account).finally(() => {
        if (inFlight.get(accountId)?.promise === promise)
          inFlight.delete(accountId);
      });
      inFlight.set(accountId, { generation, promise });
      return promise;
    },
  };
}
