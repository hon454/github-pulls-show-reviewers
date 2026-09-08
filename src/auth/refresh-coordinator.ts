import { PROACTIVE_REFRESH_THRESHOLD_MS } from "../config/proactive-refresh";
import { refreshAccessToken, RefreshTokenError } from "../github/auth";
import {
  accountMutations,
  credentialGeneration,
  type Account,
} from "../storage/accounts";

// Runtime responses contain only a non-secret revision. Callers reread storage
// before retrying; a removed account must never fall back to a returned token.
export type RefreshOutcome =
  | { ok: true; generation: string }
  | { ok: false; terminal: boolean };

export type RefreshCoordinator = {
  refreshAccountToken(
    accountId: string,
    failedGeneration: string,
  ): Promise<RefreshOutcome>;
  invalidateAccountToken(
    accountId: string,
    failedGeneration: string,
  ): Promise<void>;
  refreshAccountIfDue(accountId: string, now: number): Promise<RefreshOutcome>;
};

function outcomeFor(account: Account | null): RefreshOutcome {
  return account != null && !account.invalidated
    ? { ok: true, generation: credentialGeneration(account) }
    : { ok: false, terminal: true };
}

export function createRefreshCoordinator(input: {
  getClientId: () => string;
}): RefreshCoordinator {
  type RecoveryAdmission = {
    kind: "recovery";
    generation: Promise<string | null>;
    result: Promise<RefreshOutcome>;
  };
  type InvalidationAdmission = {
    kind: "invalidation";
    generation: string;
    result: Promise<void>;
  };
  type Admission = RecoveryAdmission | InvalidationAdmission;
  const admissions = new Map<string, Set<Admission>>();
  function pendingFor(accountId: string): Set<Admission> {
    let pending = admissions.get(accountId);
    if (!pending) {
      pending = new Set();
      admissions.set(accountId, pending);
    }
    return pending;
  }

  const inFlight = new Map<
    string,
    {
      generation: string;
      promise: Promise<RefreshOutcome>;
    }
  >();

  async function rotate(account: Account): Promise<RefreshOutcome> {
    const generation = credentialGeneration(account);
    try {
      const result = await refreshAccessToken({
        clientId: input.getClientId(),
        refreshToken: account.refreshToken!,
      });
      // Omitted rotation fields preserve the old refresh token and expiry.
      return outcomeFor(
        await accountMutations.commitAuth(account.id, generation, {
          tokens: {
            token: result.accessToken,
            refreshToken: result.refreshToken ?? account.refreshToken,
            expiresAt: result.expiresAt,
            refreshTokenExpiresAt:
              result.refreshTokenExpiresAt ?? account.refreshTokenExpiresAt,
          },
        }),
      );
    } catch (error) {
      if (error instanceof RefreshTokenError && error.kind === "terminal") {
        return outcomeFor(
          await accountMutations.commitAuth(account.id, generation, {
            invalidatedReason: "refresh_failed",
          }),
        );
      }
      return { ok: false, terminal: false };
    }
  }

  async function runRecovery(
    accountId: string,
    request: { failedGeneration: string } | { now: number },
    earlierInvalidations: Map<string, Promise<void>>,
    identify: (generation: string | null) => void,
  ): Promise<RefreshOutcome> {
    // The owner completes initialization/repair before admitting this read.
    let account = await accountMutations.getAccountById(accountId);
    // Later recovery cannot overtake an already admitted invalidation of its
    // current generation. Reauthentication's different generation is free to
    // progress. This loop only drains the finite earlier snapshot; no retries
    // or HTTP run here, and every wait is outside the registry queue.
    while (account && !account.invalidated) {
      const generation = credentialGeneration(account);
      const earlier = earlierInvalidations.get(generation);
      if (!earlier) break;
      earlierInvalidations.delete(generation);
      await earlier;
      account = await accountMutations.getAccountById(accountId);
    }
    identify(account ? credentialGeneration(account) : null);
    if (account == null || account.invalidated)
      return { ok: false, terminal: true };
    const generation = credentialGeneration(account);
    const existing = inFlight.get(accountId);
    if (existing?.generation === generation) return existing.promise;

    if ("failedGeneration" in request) {
      // This check precedes even the no-refresh-token decision: an old 401
      // cannot revoke or rotate credentials from a later sign-in.
      if (request.failedGeneration !== generation) return outcomeFor(account);
      if (account.refreshToken == null) {
        return outcomeFor(
          await accountMutations.commitAuth(accountId, generation, {
            invalidatedReason: "revoked",
          }),
        );
      }
    } else {
      // Alarm snapshots are hints. Expiry and eligibility are decided here
      // using current storage, then checked again at the conditional commit.
      if (
        account.refreshTokenExpiresAt != null &&
        account.refreshTokenExpiresAt <= request.now
      ) {
        return outcomeFor(
          await accountMutations.commitAuth(accountId, generation, {
            invalidatedReason: "expired",
          }),
        );
      }
      if (
        account.refreshToken == null ||
        account.expiresAt == null ||
        account.expiresAt - request.now >= PROACTIVE_REFRESH_THRESHOLD_MS
      ) {
        return outcomeFor(account);
      }
    }

    // HTTP runs outside the shared registry queue. A replacement generation
    // may start its own recovery without waiting on obsolete network work.
    const promise = rotate(account).finally(() => {
      if (inFlight.get(accountId)?.promise === promise)
        inFlight.delete(accountId);
    });
    inFlight.set(accountId, { generation, promise });
    return promise;
  }

  function recover(
    accountId: string,
    request: { failedGeneration: string } | { now: number },
  ): Promise<RefreshOutcome> {
    const pending = pendingFor(accountId);
    const earlierInvalidations = new Map(
      [...pending]
        .filter(
          (item): item is InvalidationAdmission => item.kind === "invalidation",
        )
        .map((item) => [item.generation, item.result]),
    );
    let identify!: (generation: string | null) => void;
    const generation = new Promise<string | null>((resolve) => {
      identify = resolve;
    });
    const admission: RecoveryAdmission = {
      kind: "recovery",
      generation,
      // Register synchronously, before even the first owner storage await.
      result: Promise.resolve()
        .then(() =>
          runRecovery(accountId, request, earlierInvalidations, identify),
        )
        .finally(() => {
          identify(null); // Also release identity waiters when a storage read fails.
          pending.delete(admission);
          if (pending.size === 0) admissions.delete(accountId);
        }),
    };
    pending.add(admission);
    return admission.result;
  }

  function invalidateAccountToken(
    accountId: string,
    failedGeneration: string,
  ): Promise<void> {
    const pending = pendingFor(accountId);
    for (const item of pending) {
      if (item.kind === "invalidation" && item.generation === failedGeneration)
        return item.result;
    }
    const earlierRecoveries = [...pending].filter(
      (item): item is RecoveryAdmission => item.kind === "recovery",
    );
    const admission: InvalidationAdmission = {
      kind: "invalidation",
      generation: failedGeneration,
      result: Promise.resolve()
        .then(async () => {
          // Only earlier admissions are dependencies, so a later recovery waiting
          // on this invalidation cannot create a cycle. Identity is resolved by
          // the current storage read, including for proactive recovery.
          await Promise.all(
            earlierRecoveries.map(async (item) => {
              if ((await item.generation) === failedGeneration)
                await item.result;
            }),
          );
          await accountMutations.commitAuth(accountId, failedGeneration, {
            invalidatedReason: "revoked",
          });
        })
        .finally(() => {
          pending.delete(admission);
          if (pending.size === 0) admissions.delete(accountId);
        }),
    };
    pending.add(admission);
    return admission.result;
  }

  return {
    refreshAccountToken: (accountId, failedGeneration) =>
      recover(accountId, { failedGeneration }),
    refreshAccountIfDue: (accountId, now) => recover(accountId, { now }),
    invalidateAccountToken,
  };
}
