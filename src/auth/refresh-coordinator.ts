import {
  refreshAccessToken,
  RefreshTokenError,
} from "../github/auth";
import {
  getAccountById,
  markAccountInvalidated,
  updateAccountTokens,
} from "../storage/accounts";

export type RefreshOutcome =
  | { ok: true; token: string }
  | { ok: false; terminal: boolean };

export type RefreshCoordinator = {
  refreshAccountToken(accountId: string): Promise<RefreshOutcome>;
};

export function createRefreshCoordinator(input: {
  getClientId: () => string;
}): RefreshCoordinator {
  const inFlight = new Map<string, Promise<RefreshOutcome>>();

  async function run(accountId: string): Promise<RefreshOutcome> {
    const account = await getAccountById(accountId);
    if (!account || account.refreshToken == null) {
      return { ok: false, terminal: true };
    }

    try {
      const result = await refreshAccessToken({
        clientId: input.getClientId(),
        refreshToken: account.refreshToken,
      });
      // GitHub may omit refresh_token / refresh_token_expires_in on a successful
      // refresh when no rotation occurred. Treat null as "no rotation" and
      // preserve the existing stored values rather than clearing them.
      await updateAccountTokens(accountId, {
        token: result.accessToken,
        refreshToken: result.refreshToken ?? account.refreshToken,
        expiresAt: result.expiresAt,
        refreshTokenExpiresAt:
          result.refreshTokenExpiresAt ?? account.refreshTokenExpiresAt,
      });
      return { ok: true, token: result.accessToken };
    } catch (error) {
      if (error instanceof RefreshTokenError && error.kind === "terminal") {
        await markAccountInvalidated(accountId, "refresh_failed");
        return { ok: false, terminal: true };
      }
      return { ok: false, terminal: false };
    }
  }

  return {
    refreshAccountToken(accountId: string): Promise<RefreshOutcome> {
      const existing = inFlight.get(accountId);
      if (existing) {
        return existing;
      }
      const promise = run(accountId).finally(() => {
        inFlight.delete(accountId);
      });
      inFlight.set(accountId, promise);
      return promise;
    },
  };
}
