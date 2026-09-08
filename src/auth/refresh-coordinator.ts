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

  async function recover(
    accountId: string,
    request: { failedGeneration: string } | { now: number },
  ): Promise<RefreshOutcome> {
    // The owner completes initialization/repair before admitting this read.
    const account = await accountMutations.getAccountById(accountId);
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

  return {
    refreshAccountToken: (accountId, failedGeneration) =>
      recover(accountId, { failedGeneration }),
    refreshAccountIfDue: (accountId, now) => recover(accountId, { now }),
    async invalidateAccountToken(accountId, failedGeneration): Promise<void> {
      // GitHub may have rotated this generation while its successful response
      // is still in transit. Let that recovery commit before deciding whether
      // the rejected retry still identifies the current credential. This wait
      // is outside the registry queue and never waits on another generation.
      const pending = inFlight.get(accountId);
      if (pending?.generation === failedGeneration) await pending.promise;
      await accountMutations.commitAuth(accountId, failedGeneration, {
        invalidatedReason: "revoked",
      });
    },
  };
}
