import type { RefreshCoordinator } from "../auth/refresh-coordinator";
import { fetchPullReviewerSummary, extractGitHubApiStatus } from "../github/api";
import {
  getAccountById,
  markAccountInvalidated,
} from "../storage/accounts";
import {
  serializeReviewerFetchError,
  type FetchPullReviewerSummaryMessage,
  type FetchPullReviewerSummaryResponse,
} from "../runtime/reviewer-fetch";

export async function handleFetchPullReviewerSummaryMessage(input: {
  message: FetchPullReviewerSummaryMessage;
  refreshCoordinator: RefreshCoordinator;
}): Promise<FetchPullReviewerSummaryResponse> {
  const { message, refreshCoordinator } = input;
  const account =
    message.accountId == null ? null : await getAccountById(message.accountId);

  const execute = (token: string | null) =>
    fetchPullReviewerSummary({
      owner: message.owner,
      repo: message.repo,
      pullNumber: message.pullNumber,
      githubToken: token,
    });

  try {
    const summary = await execute(account?.token ?? null);
    return { ok: true, summary };
  } catch (error) {
    if (extractGitHubApiStatus(error) !== 401 || account == null) {
      return {
        ok: false,
        error: serializeReviewerFetchError(error),
      };
    }

    if (account.refreshToken == null) {
      await markAccountInvalidated(account.id, "revoked");
      return {
        ok: false,
        error: serializeReviewerFetchError(error),
      };
    }

    const outcome = await refreshCoordinator.refreshAccountToken(account.id);
    if (outcome.ok !== true) {
      return {
        ok: false,
        error: serializeReviewerFetchError(error),
      };
    }

    const refreshed = await getAccountById(account.id);
    try {
      const summary = await execute(refreshed?.token ?? outcome.token);
      return { ok: true, summary };
    } catch (retryError) {
      if (extractGitHubApiStatus(retryError) === 401) {
        await markAccountInvalidated(account.id, "revoked");
      }
      return {
        ok: false,
        error: serializeReviewerFetchError(retryError),
      };
    }
  }
}
