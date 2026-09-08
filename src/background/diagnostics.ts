import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import { validateRepositoryAccessWithAccount } from "../auth/account-token-refresh";
import {
  extractRepositoryValidationFailures,
  validateGitHubRepositoryAccess,
  type RepositoryValidationResult,
} from "../github/api";
import { resolveAccountCoverageForRepo } from "../storage/accounts";
import {
  repositoryDiagnosticSchema,
  repositoryValidationSummarySchema,
} from "../runtime/diagnostics";

export function sanitizeRepositoryValidation(
  result: RepositoryValidationResult,
) {
  // Parsing allowlisted fields also drops nested headers/tokens and error prose.
  return repositoryValidationSummarySchema.parse(result);
}

export function createDiagnosticsService(coordinator: RefreshCoordinator) {
  return async (owner: string, repo: string, mode: "matched" | "no-token") => {
    const repository = `${owner}/${repo}`;
    try {
      if (mode === "no-token")
        return repositoryDiagnosticSchema.parse({
          kind: "no-token",
          repository,
          result: sanitizeRepositoryValidation(
            await validateGitHubRepositoryAccess(null, repository),
          ),
        });
      const resolution = await resolveAccountCoverageForRepo(owner, repo);
      if (resolution.status === "uncovered")
        return { kind: "uncovered" as const, repository };
      const result = await validateRepositoryAccessWithAccount({
        account: resolution.account,
        repository,
        coordinator,
      });
      return repositoryDiagnosticSchema.parse({
        kind: "matched",
        repository,
        coverageStatus: resolution.status,
        account: { login: resolution.account.login },
        result: sanitizeRepositoryValidation(result),
      });
    } catch (error) {
      return repositoryDiagnosticSchema.parse({
        kind: "failed",
        failures: extractRepositoryValidationFailures(error),
      });
    }
  };
}
