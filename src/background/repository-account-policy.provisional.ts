/**
 * #176 Phase P only: independent, provisional policy inputs.
 *
 * These facts are NOT #175 account/runtime contracts. Nothing imports this
 * module except its independent tests. Adapt or replace these inputs after
 * #175 is merged and verified; do not wire them to storage, HTTP, or UI first.
 */
export type ProvisionalInstallationFact = Readonly<
  { owner: string } & (
    | { selection: "all" }
    | {
        selection: "selected";
        repositoryFullNames: readonly string[];
        truncated: boolean;
      }
  )
>;

export type ProvisionalAccountFact = Readonly<{
  accountId: string;
  present: boolean;
  active: boolean;
  installations: readonly ProvisionalInstallationFact[];
}>;

export type ProvisionalCandidate = Readonly<{
  accountId: string;
  tier: "covered" | "truncated";
}>;

/**
 * The array is a coherent snapshot in current listAccounts() order, with the
 * first record for an ID authoritative if duplicated. IDs remain opaque.
 * This only enumerates alternatives; it does not change initial resolution,
 * reserve an attempt, or replace the required recheck immediately before HTTP.
 * A complete selected miss stays excluded until self-healing changes the facts.
 */
export function orderProvisionalRepositoryCandidates(input: {
  owner: string;
  repo: string;
  accounts: readonly ProvisionalAccountFact[];
  attemptedAccountIds: readonly string[];
}): ProvisionalCandidate[] {
  const owner = input.owner.toLowerCase();
  const fullName = `${owner}/${input.repo.toLowerCase()}`;
  const excluded = new Set(input.attemptedAccountIds);
  const covered: ProvisionalCandidate[] = [];
  const truncated: ProvisionalCandidate[] = [];

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
export type ProvisionalFailureFact = Readonly<{
  kind: "http" | "network" | "schema" | "cancellation" | "unknown";
  status: number | null;
  scope: "repository" | "pull" | "unknown";
  rateLimited?: boolean;
  rateLimitRemaining?: number | null;
  secondaryRateLimited?: boolean;
}>;

export type ProvisionalFailureDecision =
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
 * the future owner must retain the full sanitized envelope for final results.
 *
 * A PR-only denial needs repository evidence before another account is tried
 * or a repository-wide negative is written. Neither result reserves a probe.
 * Anonymous fallback has its own existing policy and must never use this one.
 */
export function classifyProvisionalRepositoryFailure(input: {
  authenticated: boolean;
  failures: readonly ProvisionalFailureFact[];
}): ProvisionalFailureDecision {
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
