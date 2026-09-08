import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import { validateRepositoryAccessWithAccount } from "../auth/account-token-refresh";
import {
  extractRepositoryValidationFailures,
  validateGitHubRepositoryAccess,
  type RepositoryValidationResult,
} from "../github/api";
import {
  accountMutations,
  resolveAccountCoverageForRepo,
} from "../storage/accounts";
import type { RepositoryAccountService } from "./repository-accounts";
import type { DiscoveryOwner } from "./repository-discovery-ledger";
import {
  ReviewerFetchRuntimeError,
  serializeReviewerFetchError,
} from "../runtime/reviewer-fetch";
import type { AccountSummary } from "../runtime/ui-contract";
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

export function createDiagnosticsService(
  coordinator: RefreshCoordinator,
  repositories?: RepositoryAccountService,
) {
  return async (
    owner: string,
    repo: string,
    mode: "matched" | "no-token",
    run?: {
      owner: DiscoveryOwner;
      runId: string;
      generation: number;
      signal: AbortSignal;
    },
  ) => {
    const repository = `${owner}/${repo}`;
    try {
      if (mode === "no-token")
        return repositoryDiagnosticSchema.parse({
          kind: "no-token",
          repository,
          result: sanitizeRepositoryValidation(
            await validateGitHubRepositoryAccess(null, repository, run?.signal),
          ),
        });
      if (repositories && run) {
        let account: AccountSummary | null = null;
        let pullNumber: string | undefined;
        let result: unknown;
        try {
          const discovery = await repositories.begin(run.owner, {
            owner,
            repo,
            pageSession: run.runId,
            generation: run.generation,
          });
          const access = await repositories.metadata(
            run.owner,
            discovery,
            run.signal,
          );
          account = access.account;
          if (!account) return { kind: "uncovered" as const, repository };
          const pull = access.metadata?.[0];
          pullNumber = pull?.number;
          if (pull) {
            const checked = await repositories.summary(run.owner, discovery, {
              pullNumber: pull.number,
              signal: run.signal,
              validatePull: true,
            });
            account = checked.account;
            result = {
              ok: true,
              authMode: "token",
              outcome: "accessible",
              fullName: repository,
              pullNumber,
            };
          } else
            result = {
              ok: false,
              authMode: "token",
              outcome: "no-pulls",
              fullName: repository,
            };
        } catch (error) {
          if (error instanceof ReviewerFetchRuntimeError)
            account = error.account ?? account;
          const envelope = serializeReviewerFetchError(error);
          const failures = envelope.failures ?? [];
          const primary =
            failures.find(
              (failure) =>
                failure.rateLimited ||
                failure.status === 429 ||
                failure.rateLimit?.remaining === 0,
            ) ??
            failures.find((failure) => failure.status === 401) ??
            failures.find(
              (failure) =>
                (failure.kind && failure.kind !== "http") ||
                ![403, 404].includes(failure.status ?? 0),
            ) ??
            failures[0];
          result = {
            ok: false,
            authMode: "token",
            fullName: repository,
            ...(pullNumber ? { pullNumber } : {}),
            outcome:
              primary?.rateLimited ||
              primary?.status === 429 ||
              primary?.rateLimit?.remaining === 0
                ? "authenticated-rate-limit"
                : primary?.status === 401
                  ? "token-invalid"
                  : primary?.status === 403
                    ? "token-permission"
                    : primary?.status === 404
                      ? "token-not-found"
                      : "unknown-error",
            failures: failures.map((failure) => ({
              kind: failure.kind ?? "http",
              ...(failure.status === null
                ? {}
                : { httpStatus: failure.status }),
              ...(failure.rateLimit ? { rateLimit: failure.rateLimit } : {}),
              ...(failure.rateLimited ? { rateLimited: true } : {}),
              ...(failure.endpoint
                ? {
                    endpoint: {
                      name: /\/pulls\?/.test(failure.endpoint)
                        ? "pulls-list"
                        : /\/reviews/.test(failure.endpoint)
                          ? "reviews"
                          : "pull",
                      method: "GET",
                      path: failure.endpoint,
                    },
                  }
                : {}),
            })),
          };
        }
        if (!account)
          return repositoryDiagnosticSchema.parse({
            kind: "failed",
            failures: [{ kind: "unknown" }],
          });
        const stored = await accountMutations.getAccountById(account.id);
        const covered = stored?.installations.some(
          (installation) =>
            installation.account.login.toLowerCase() === owner.toLowerCase() &&
            (installation.repositorySelection === "all" ||
              installation.repoSnapshot.fullNames.some(
                (name) => name.toLowerCase() === repository.toLowerCase(),
              )),
        );
        return repositoryDiagnosticSchema.parse({
          kind: "matched",
          repository,
          coverageStatus: covered ? "covered" : "maybe-covered-truncated",
          account: { login: account.login },
          result,
        });
      }
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
