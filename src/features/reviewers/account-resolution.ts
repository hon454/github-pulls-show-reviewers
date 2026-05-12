import {
  listAccounts,
  resolveAccountForRepo,
  type Account,
} from "../../storage/accounts";

export type SelfHealingAccountResolver = {
  resolveAccount(owner: string, repo: string): Promise<Account | null>;
  resolveFallbackAccount(owner: string): Promise<Account | null>;
};

export type RequestInstallationsRefresh = (
  accountId: string,
) => Promise<boolean>;

export function createSelfHealingAccountResolver(input: {
  requestRefresh: RequestInstallationsRefresh;
}): SelfHealingAccountResolver {
  const { requestRefresh } = input;
  // Page-session memo: refresh each candidate at most once. We persist the
  // attempt outcome in the Set whether it succeeded or failed so that a
  // failing refresh does not get retried for every row that hits the same
  // owner.
  const attemptedRefreshes = new Set<string>();
  const inFlightRefreshes = new Map<string, Promise<boolean>>();

  function dedupedRefresh(accountId: string): Promise<boolean> {
    const existing = inFlightRefreshes.get(accountId);
    if (existing) {
      return existing;
    }
    const promise = requestRefresh(accountId)
      .catch(() => false)
      .finally(() => {
        attemptedRefreshes.add(accountId);
        inFlightRefreshes.delete(accountId);
      });
    inFlightRefreshes.set(accountId, promise);
    return promise;
  }

  async function findStaleCandidates(
    owner: string,
    repo: string,
  ): Promise<string[]> {
    const accounts = await listAccounts();
    const normalizedOwner = owner.toLowerCase();
    const normalizedFullName = `${normalizedOwner}/${repo.toLowerCase()}`;
    const candidates: string[] = [];

    for (const account of accounts) {
      if (account.invalidated) {
        continue;
      }
      const ownerInstallations = account.installations.filter(
        (installation) =>
          installation.account.login.toLowerCase() === normalizedOwner,
      );
      if (ownerInstallations.length === 0) {
        continue;
      }
      // If any installation already covers the repo, resolveAccountForRepo
      // should have returned this account. Treat it as not-stale and skip.
      const alreadyCovers = ownerInstallations.some((installation) => {
        if (installation.repositorySelection === "all") {
          return true;
        }
        const fullNames = installation.repoFullNames ?? [];
        return fullNames.some(
          (name) => name.toLowerCase() === normalizedFullName,
        );
      });
      if (alreadyCovers) {
        continue;
      }
      candidates.push(account.id);
    }

    return candidates;
  }

  return {
    async resolveAccount(owner: string, repo: string): Promise<Account | null> {
      const initial = await resolveAccountForRepo(owner, repo);
      if (initial != null) {
        return initial;
      }

      const candidates = await findStaleCandidates(owner, repo);
      const refreshable = candidates.filter(
        (accountId) => !attemptedRefreshes.has(accountId),
      );
      if (refreshable.length === 0) {
        return null;
      }

      await Promise.all(
        refreshable.map((accountId) => dedupedRefresh(accountId)),
      );

      return await resolveAccountForRepo(owner, repo);
    },
    async resolveFallbackAccount(owner: string): Promise<Account | null> {
      const accounts = (await listAccounts()).filter(
        (account) => !account.invalidated,
      );
      const normalizedOwner = owner.toLowerCase();
      const ownerAccount = accounts.find(
        (account) => account.login.toLowerCase() === normalizedOwner,
      );
      if (ownerAccount != null) {
        return ownerAccount;
      }
      return accounts.length === 1 ? accounts[0] : null;
    },
  };
}
