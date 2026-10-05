import type { Installation } from "../storage/accounts";
import { fetchInstallationRepositories, fetchUserInstallations } from "./auth";

type LoadInput = { token: string; signal?: AbortSignal };

export async function loadAccountInstallations(
  input: LoadInput,
): Promise<Installation[]> {
  return (await load(input, false)).installations;
}

/**
 * Like `loadAccountInstallations`, but returns the installations loaded before
 * the page limit instead of failing when the installation list is truncated.
 */
export function loadAccountInstallationSnapshot(
  input: LoadInput,
): Promise<{ installations: Installation[]; truncated: boolean }> {
  return load(input, true);
}

async function load(
  input: LoadInput,
  allowTruncated: boolean,
): Promise<{ installations: Installation[]; truncated: boolean }> {
  input.signal?.throwIfAborted();
  const signal = input.signal ? { signal: input.signal } : {};
  const apiInstallations = await fetchUserInstallations({
    token: input.token,
    ...signal,
  });
  input.signal?.throwIfAborted();
  if (apiInstallations.truncated && !allowTruncated) {
    throw new Error(
      "GitHub App installation list was truncated before all installations were loaded.",
    );
  }

  const installations = await Promise.all(
    apiInstallations.items.map(async (installation): Promise<Installation> => {
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
        ...signal,
      });
      input.signal?.throwIfAborted();
      return {
        id: installation.id,
        account: installation.account,
        repositorySelection: "selected",
        repoSnapshot: {
          fullNames: repositories.items,
          completeness: repositories.truncated ? "truncated" : "complete",
        },
      };
    }),
  );
  return { installations, truncated: apiInstallations.truncated };
}
