import {
  throwIfReviewerAborted,
  waitForReviewerSignal,
} from "../shared/reviewer-deadline";
import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import {
  accountMutations,
  credentialGeneration,
  type Account,
} from "../storage/accounts";
import {
  ReviewerFetchRuntimeError,
  serializeReviewerFetchError,
} from "../runtime/reviewer-fetch";
import {
  classifyRepositoryFailure,
  type RepositoryFailureFact,
} from "./repository-account-policy";

/** Authentication incarnation/coverage, intentionally independent of token rotation. */
export function accountAccessKey(account: Account): string {
  return JSON.stringify({
    id: account.id,
    login: account.login,
    createdAt: account.createdAt,
    connectionAttemptId: account.connectionAttemptId ?? null,
    invalidated: account.invalidated,
    invalidatedReason: account.invalidatedReason,
    installations: account.installations,
    installationsRefreshedAt: account.installationsRefreshedAt,
  });
}

/** Invalidation retires access but cannot by itself authorize account cycling. */
export function accountDiscoveryKey(account: Account): string {
  return accountAccessKey({
    ...account,
    invalidated: false,
    invalidatedReason: null,
  });
}

export async function accountAccessRevision(account: Account): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(accountAccessKey(account)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function repositoryFailureFacts(
  error: unknown,
): RepositoryFailureFact[] {
  const envelope = serializeReviewerFetchError(error);
  return (envelope.failures ?? []).map((failure) => ({
    kind:
      failure.kind ??
      (envelope.kind === "github-api" || envelope.kind === "github-endpoints"
        ? "http"
        : "unknown"),
    status: failure.status,
    scope:
      failure.endpoint &&
      /^\/repos\/[^/]+\/[^/]+\/pulls(?:\?|$)/.test(failure.endpoint)
        ? "repository"
        : failure.endpoint
          ? "pull"
          : "unknown",
    rateLimited: failure.rateLimited,
    rateLimitRemaining: failure.rateLimit?.remaining ?? null,
  }));
}

export function classifyAuthenticatedFailure(error: unknown) {
  return classifyRepositoryFailure({
    authenticated: true,
    failures: repositoryFailureFacts(error),
  });
}

export function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

export const waitWithSignal = waitForReviewerSignal;

/** The existing #166 coordinator is the sole refresh/invalidation owner. */
export function createAccountRequest(coordinator: RefreshCoordinator) {
  return async function run<T>(input: {
    accountId: string | null;
    signal: AbortSignal;
    expectedAccessKey?: string | undefined;
    onFailure?:
      | ((
          error: unknown | undefined,
          account: Account | null,
        ) => void | Promise<void>)
      | undefined;
    execute: (token: string | null, signal: AbortSignal) => Promise<T>;
  }): Promise<{ value: T; account: Account | null }> {
    const checkAbort = () => {
      throwIfReviewerAborted(input.signal);
    };
    checkAbort();
    const account =
      input.accountId === null
        ? null
        : await accountMutations.getAccountById(input.accountId);
    checkAbort();
    if (input.accountId !== null && (!account || account.invalidated)) {
      throw new ReviewerFetchRuntimeError({
        kind: "unknown",
        status: null,
        discoveryOutcome: "retired",
      });
    }
    const accessKey = account ? accountAccessKey(account) : null;
    if (
      input.expectedAccessKey !== undefined &&
      accessKey !== input.expectedAccessKey
    ) {
      throw new ReviewerFetchRuntimeError({
        kind: "unknown",
        status: null,
        discoveryOutcome: "retired",
      });
    }
    async function verifyIdentity() {
      checkAbort();
      if (account) {
        const current = await accountMutations.getAccountById(account.id);
        checkAbort();
        if (!current || accountAccessKey(current) !== accessKey) {
          throw new ReviewerFetchRuntimeError({
            kind: "unknown",
            status: null,
            discoveryOutcome: "retired",
          });
        }
      }
    }
    async function execute(used: Account | null) {
      try {
        checkAbort();
        await input.onFailure?.(undefined, used);
        checkAbort();
        const value = await waitWithSignal(
          input.execute(used?.token ?? null, input.signal),
          input.signal,
        );
        await verifyIdentity();
        return { value, account: used };
      } catch (error) {
        checkAbort();
        await input.onFailure?.(error, used);
        await verifyIdentity();
        throw error;
      }
    }
    try {
      return await execute(account);
    } catch (error) {
      const decision = classifyAuthenticatedFailure(error);
      if (
        !account ||
        decision.kind !== "stop" ||
        decision.reason !== "authentication"
      )
        throw error;
      checkAbort();
      const outcome = await waitWithSignal(
        coordinator.refreshAccountToken(
          account.id,
          credentialGeneration(account),
        ),
        input.signal,
      );
      checkAbort();
      if (!outcome.ok) {
        const current = await accountMutations.getAccountById(account.id);
        checkAbort();
        // The coordinator may invalidate this exact auth incarnation. Preserve
        // its unresolved 401 while still rejecting replacement-account results.
        if (
          current &&
          accountDiscoveryKey(current) === accountDiscoveryKey(account)
        )
          throw error;
      }
      await verifyIdentity();
      if (!outcome.ok) throw error;
      const refreshed = await accountMutations.getAccountById(account.id);
      checkAbort();
      if (
        !refreshed ||
        refreshed.invalidated ||
        accountAccessKey(refreshed) !== accessKey
      )
        throw error;
      try {
        return await execute(refreshed);
      } catch (retryError) {
        checkAbort();
        const retryDecision = classifyAuthenticatedFailure(retryError);
        if (
          retryDecision.kind === "stop" &&
          retryDecision.reason === "authentication"
        ) {
          await coordinator.invalidateAccountToken(
            refreshed.id,
            credentialGeneration(refreshed),
          );
        }
        throw retryError;
      }
    }
  };
}
