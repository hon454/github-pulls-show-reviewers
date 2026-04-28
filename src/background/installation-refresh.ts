import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import { extractGitHubApiStatus } from "../github/api";
import {
  fetchInstallationRepositories,
  fetchUserInstallations,
} from "../github/auth";
import {
  getAccountById,
  markAccountInvalidated,
  replaceInstallations,
  type Account,
  type Installation,
} from "../storage/accounts";

export type InstallationRefreshOutcome =
  | { ok: true }
  | { ok: false; reason: "no-account" | "invalidated" | "failed" };

export type InstallationRefreshService = {
  refreshAccountInstallations(accountId: string): Promise<InstallationRefreshOutcome>;
};

export function createInstallationRefreshService(input: {
  refreshCoordinator: RefreshCoordinator;
}): InstallationRefreshService {
  const { refreshCoordinator } = input;
  const inFlight = new Map<string, Promise<InstallationRefreshOutcome>>();

  async function loadInstallationsWithToken(token: string): Promise<Installation[]> {
    const apiInstallations = await fetchUserInstallations({ token });
    return Promise.all(
      apiInstallations.map(async (installation): Promise<Installation> => ({
        id: installation.id,
        account: installation.account,
        repositorySelection: installation.repositorySelection,
        repoFullNames:
          installation.repositorySelection === "selected"
            ? await fetchInstallationRepositories({
                token,
                installationId: installation.id,
              })
            : null,
      })),
    );
  }

  async function run(accountId: string): Promise<InstallationRefreshOutcome> {
    const account = await getAccountById(accountId);
    if (account == null) {
      return { ok: false, reason: "no-account" };
    }
    if (account.invalidated) {
      return { ok: false, reason: "invalidated" };
    }

    try {
      const installations = await loadInstallationsWithToken(account.token);
      await replaceInstallations(account.id, installations);
      return { ok: true };
    } catch (error) {
      if (extractGitHubApiStatus(error) !== 401) {
        return { ok: false, reason: "failed" };
      }

      if (account.refreshToken == null) {
        await markAccountInvalidated(account.id, "revoked");
        return { ok: false, reason: "failed" };
      }

      const refreshOutcome = await refreshCoordinator.refreshAccountToken(account.id);
      if (!refreshOutcome.ok) {
        return { ok: false, reason: "failed" };
      }

      const refreshed: Account | null = await getAccountById(account.id);
      const tokenForRetry = refreshed?.token ?? refreshOutcome.token;
      try {
        const installations = await loadInstallationsWithToken(tokenForRetry);
        await replaceInstallations(account.id, installations);
        return { ok: true };
      } catch (retryError) {
        if (extractGitHubApiStatus(retryError) === 401) {
          await markAccountInvalidated(account.id, "revoked");
        }
        return { ok: false, reason: "failed" };
      }
    }
  }

  return {
    refreshAccountInstallations(accountId: string): Promise<InstallationRefreshOutcome> {
      const existing = inFlight.get(accountId);
      if (existing) {
        return existing;
      }
      const promise = run(accountId).finally(() => {
        inFlight.delete(accountId);
      });
      inFlight.set(accountId, promise);
      return promise;
    },
  };
}
