import type { Installation } from "../storage/accounts";
import {
  fetchInstallationRepositories,
  fetchUserInstallations,
} from "./auth";

export async function loadAccountInstallations(input: {
  token: string;
}): Promise<Installation[]> {
  const apiInstallations = await fetchUserInstallations({ token: input.token });
  if (apiInstallations.truncated) {
    throw new Error(
      "GitHub App installation list was truncated before all installations were loaded.",
    );
  }

  return Promise.all(
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
      });
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
}
