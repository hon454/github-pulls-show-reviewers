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
 * changes nothing; the next pass retries. Accounts are never invalidated here.
 */
export function createAccountIdentityBackfill(): AccountIdentityBackfill {
  let running: Promise<void> | undefined;

  async function run(): Promise<void> {
    const pending = (await accountMutations.listAccounts()).filter(
      (account) => !account.invalidated && account.userId == null,
    );
    for (const account of pending) {
      try {
        const user = await fetchAuthenticatedUser({ token: account.token });
        await accountMutations.backfillUserId(
          account.id,
          credentialGeneration(account),
          user,
        );
      } catch {
        // Transient or credential failures are left to the refresh paths.
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
