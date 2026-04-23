import {
  refreshAccessToken,
  RefreshTokenError,
} from "../github/auth";
import {
  listAccounts,
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
    const accounts = await listAccounts();
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (!account || account.refreshToken == null) {
      return { ok: false, terminal: true };
    }

    try {
      const result = await refreshAccessToken({
        clientId: input.getClientId(),
        refreshToken: account.refreshToken,
      });
      await updateAccountTokens(accountId, {
        token: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        refreshTokenExpiresAt: result.refreshTokenExpiresAt,
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
