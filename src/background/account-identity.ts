import { extractGitHubApiStatus } from "../github/api";
import { fetchAuthenticatedUser } from "../github/auth";
import { accountMutations, credentialGeneration } from "../storage/accounts";

export type AccountIdentityBackfill = {
  backfillMissingUserIds(): Promise<void>;
};

/**
 * Records written before the numeric GitHub user id was stored keep working
 * without re-authentication. Each pass asks GitHub's /user once for every
 * valid record that still lacks the id, outside the registry queue, and
 * commits the id only under the revision that made the request. A failure
 * changes nothing; the next pass retries, except for credentials GitHub
 * rejected (401) in this worker. Accounts are never invalidated here.
 */
export function createAccountIdentityBackfill(): AccountIdentityBackfill {
  let running: Promise<void> | undefined;
  const rejectedGenerations = new Set<string>();

  async function run(): Promise<void> {
    const pending = (await accountMutations.listAccounts()).filter(
      (account) =>
        !account.invalidated &&
        account.userId == null &&
        !rejectedGenerations.has(credentialGeneration(account)),
    );
    for (const account of pending) {
      const generation = credentialGeneration(account);
      try {
        // The credential request deadline bounds each request, so one
        // backfill request never holds a pass open indefinitely.
        const user = await fetchAuthenticatedUser({ token: account.token });
        await accountMutations.backfillUserId(account.id, generation, user);
      } catch (error) {
        // Token refresh paths own credential failures; never retry the same
        // rejected credentials on every alarm.
        if (extractGitHubApiStatus(error) === 401)
          rejectedGenerations.add(generation);
      }
    }
  }

  return {
    backfillMissingUserIds() {
      running ??= run().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
