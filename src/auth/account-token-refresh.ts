import { getAccountById, markAccountInvalidated, type Account } from "../storage/accounts";

function extractStatus(error: unknown): number | null {
  if (error && typeof error === "object" && "status" in error) {
    const value = (error as { status: unknown }).status;
    return typeof value === "number" ? value : null;
  }

  if (
    error &&
    typeof error === "object" &&
    "failures" in error &&
    Array.isArray((error as { failures: unknown }).failures)
  ) {
    const first = (error as { failures: Array<{ status?: number }> }).failures[0];
    return typeof first?.status === "number" ? first.status : null;
  }

  if (error instanceof Error) {
    const match = /status (\d+)/i.exec(error.message);
    if (match) {
      return Number(match[1]);
    }
  }

  return null;
}

export async function retryWithAccountRefresh<T>(input: {
  account: Account | null;
  execute: (token: string | null) => Promise<T>;
}): Promise<T> {
  const { account, execute } = input;

  try {
    return await execute(account?.token ?? null);
  } catch (error) {
    if (extractStatus(error) !== 401 || account == null) {
      throw error;
    }

    if (account.refreshToken == null) {
      await markAccountInvalidated(account.id, "revoked");
      throw error;
    }

    const outcome = (await browser.runtime.sendMessage({
      type: "refreshAccessToken",
      accountId: account.id,
    })) as
      | { ok: true; token: string }
      | { ok: false; terminal: boolean }
      | undefined;

    if (!outcome || outcome.ok !== true) {
      throw error;
    }

    const refreshed = await getAccountById(account.id);
    try {
      return await execute(refreshed?.token ?? outcome.token);
    } catch (retryError) {
      if (extractStatus(retryError) === 401) {
        await markAccountInvalidated(account.id, "revoked");
      }
      throw retryError;
    }
  }
}
