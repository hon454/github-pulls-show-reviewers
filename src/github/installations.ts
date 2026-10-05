import type { Installation } from "../storage/accounts";
import { fetchInstallationRepositories, fetchUserInstallations } from "./auth";

/**
 * Loads the account's installations and their selected repositories.
 *
 * When the installation list reaches the local page limit, the installations
 * loaded before it are returned, for sign-in and refresh alike, so an account
 * with more installations than that can still connect; owners beyond the
 * limit resolve as uncovered. A rejected `next` link is not a page limit and
 * still fails the load. When one request fails, the load's other in-flight
 * requests are aborted.
 */
export async function loadAccountInstallations(input: {
  token: string;
  signal?: AbortSignal;
}): Promise<Installation[]> {
  input.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  const signal = controller.signal;
  try {
    const apiInstallations = await fetchUserInstallations({
      token: input.token,
      signal,
    });
    signal.throwIfAborted();
    if (apiInstallations.invalidLink) {
      throw new Error(
        "GitHub App installation list pagination returned an invalid next link.",
      );
    }

    return await Promise.all(
      apiInstallations.items.map(
        async (installation): Promise<Installation> => {
          if (installation.repositorySelection === "all") {
            return {
              id: installation.id,
              account: installation.account,
              repositorySelection: "all",
              repoSnapshot: null,
            };
          }

          const repositories = await fetchInstallationRepositories({
            token: input.token,
            installationId: installation.id,
            signal,
          });
          signal.throwIfAborted();
          return {
            id: installation.id,
            account: installation.account,
            repositorySelection: "selected",
            repoSnapshot: {
              fullNames: repositories.items,
              completeness: repositories.truncated ? "truncated" : "complete",
            },
          };
        },
      ),
    );
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}
