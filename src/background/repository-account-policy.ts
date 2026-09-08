/** Pure policy facts projected from current background-owned account records. */
export type RepositoryInstallationFact = Readonly<
  { owner: string } & (
    | { selection: "all" }
    | {
        selection: "selected";
        repositoryFullNames: readonly string[];
        truncated: boolean;
      }
  )
>;

export type RepositoryAccountFact = Readonly<{
  accountId: string;
  present: boolean;
  active: boolean;
  installations: readonly RepositoryInstallationFact[];
}>;

export type RepositoryCandidate = Readonly<{
  accountId: string;
  tier: "covered" | "truncated";
}>;

/**
 * The array is a coherent snapshot in current listAccounts() order, with the
 * first record for an ID authoritative if duplicated. IDs remain opaque.
 * This enumerates alternatives without changing initial resolution. It does not
 * reserve an attempt or replace the required recheck immediately before HTTP.
 * A complete selected miss stays excluded until self-healing changes the facts.
 */
export function orderRepositoryCandidates(input: {
  owner: string;
  repo: string;
  accounts: readonly RepositoryAccountFact[];
  attemptedAccountIds: readonly string[];
}): RepositoryCandidate[] {
  const owner = input.owner.toLowerCase();
  const fullName = `${owner}/${input.repo.toLowerCase()}`;
  const excluded = new Set(input.attemptedAccountIds);
  const covered: RepositoryCandidate[] = [];
  const truncated: RepositoryCandidate[] = [];

  for (const account of input.accounts) {
    if (excluded.has(account.accountId)) continue;
    excluded.add(account.accountId);
    if (!account.present || !account.active) continue;

    const installations = account.installations.filter(
      (installation) => installation.owner.toLowerCase() === owner,
    );
    if (
      installations.some(
        (installation) =>
          installation.selection === "all" ||
          installation.repositoryFullNames.some(
            (name) => name.toLowerCase() === fullName,
          ),
      )
    ) {
      covered.push({ accountId: account.accountId, tier: "covered" });
    } else if (
      installations.some(
        (installation) =>
          installation.selection === "selected" && installation.truncated,
      )
    ) {
      truncated.push({ accountId: account.accountId, tier: "truncated" });
    }
  }

  return [...covered, ...truncated];
}

/** Decoded, non-secret failure facts; no raw body/message or credential input. */
export type RepositoryFailureFact = Readonly<{
  kind: "http" | "network" | "schema" | "cancellation" | "unknown";
  status: number | null;
  scope: "repository" | "pull" | "unknown";
  rateLimited?: boolean;
  rateLimitRemaining?: number | null;
  secondaryRateLimited?: boolean;
}>;

export type RepositoryFailureDecision =
  | { kind: "repository-denial" }
  | { kind: "repository-evidence-required" }
  | {
      kind: "stop";
      reason:
        | "anonymous"
        | "missing-evidence"
        | "rate-limit"
        | "authentication"
        | "non-access-failure";
    };

/**
 * Inspect ALL relevant unresolved failures after same-account recovery (#166).
 * A recovered 401 belongs to the earlier attempt result, not the new envelope.
 * This classifier does not perform recovery or discard original evidence:
 * the service retains the full sanitized envelope for final results.
 *
 * A PR-only denial needs repository evidence before another account is tried
 * or a repository-wide negative is written. Neither result reserves a probe.
 * Anonymous fallback has its own existing policy and must never use this one.
 */
export function classifyRepositoryFailure(input: {
  authenticated: boolean;
  failures: readonly RepositoryFailureFact[];
}): RepositoryFailureDecision {
  if (!input.authenticated) return { kind: "stop", reason: "anonymous" };
  const { failures } = input;
  if (failures.length === 0)
    return { kind: "stop", reason: "missing-evidence" };

  if (
    failures.some(
      (failure) =>
        failure.status === 429 ||
        failure.rateLimited === true ||
        failure.rateLimitRemaining === 0 ||
        failure.secondaryRateLimited === true,
    )
  ) {
    return { kind: "stop", reason: "rate-limit" };
  }
  if (failures.some((failure) => failure.status === 401)) {
    return { kind: "stop", reason: "authentication" };
  }
  if (
    !failures.every(
      (failure) =>
        failure.kind === "http" &&
        (failure.status === 403 || failure.status === 404),
    )
  ) {
    return { kind: "stop", reason: "non-access-failure" };
  }

  return failures.some((failure) => failure.scope === "repository")
    ? { kind: "repository-denial" }
    : { kind: "repository-evidence-required" };
}
