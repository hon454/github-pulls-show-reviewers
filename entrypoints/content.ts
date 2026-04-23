import {
  bootAccessBanner,
  type AccessBannerHandle,
} from "../src/features/access-banner";
import { bootReviewerListPage } from "../src/features/reviewers";
import { parsePullListRoute } from "../src/github/routes";
import {
  GitHubApiError,
  GitHubPullRequestEndpointsError,
} from "../src/github/api";

export default defineContentScript({
  matches: ["https://github.com/*/*"],
  runAt: "document_idle",
  main(ctx) {
    let aggregator: AccessBannerHandle | null = null;
    let reviewerListBooted = false;

    const syncRouteFeatures = () => {
      aggregator?.teardown();
      aggregator = null;

      if (parsePullListRoute(window.location.pathname) == null) {
        return;
      }

      aggregator = bootAccessBanner(ctx);
      if (!reviewerListBooted) {
        reviewerListBooted = true;
        bootReviewerListPage(ctx, {
          onRowFailure({ owner, account, error }) {
            if (aggregator == null) {
              aggregator = bootAccessBanner(ctx);
            }
            if (aggregator == null) {
              return;
            }

            const signals = classifyRowFailure(error, account);
            if (signals.rateLimited) {
              aggregator.reportUnauthRateLimit();
              return;
            }
            if (signals.uncovered) {
              aggregator.reportUncoveredOwner(owner);
              return;
            }
            // Fallback for errors we cannot attribute (schema drift, network
            // failure, aborted fetch, etc.). We keep the existing behavior and
            // flag the owner as uncovered so the banner still guides the user
            // toward App installation — doing nothing here would leave the row
            // blank with no explanation.
            aggregator.reportUncoveredOwner(owner);
          },
        });
      }
    };

    syncRouteFeatures();

    ctx.addEventListener(window, "wxt:locationchange", syncRouteFeatures);
    ctx.addEventListener(window, "popstate", syncRouteFeatures);
    ctx.addEventListener(document, "turbo:render", syncRouteFeatures);
    ctx.addEventListener(document, "pjax:end", syncRouteFeatures);
  },
});

type RowFailureClassification = {
  rateLimited: boolean;
  uncovered: boolean;
};

function classifyRowFailure(
  error: unknown,
  account: { id?: string } | null,
): RowFailureClassification {
  const failures = collectApiFailures(error);

  // With no authenticated account, any 403 indicates the unauthenticated
  // tier was rejected — treat as the unauth rate-limit case so the banner
  // invites the user to sign in. Any explicit 429 is always rate-limited.
  const rateLimited = failures.some(
    (failure) =>
      failure.status === 429 ||
      (account == null && failure.status === 403),
  );
  if (rateLimited) {
    return { rateLimited: true, uncovered: false };
  }

  const uncovered = failures.some(
    (failure) => failure.status === 404 || failure.status === 403,
  );
  if (uncovered) {
    return { rateLimited: false, uncovered: true };
  }

  // No signed-in account at all: the row failure is effectively an
  // access-gate signal, not a server-side coverage problem.
  if (account == null) {
    return { rateLimited: false, uncovered: true };
  }

  return { rateLimited: false, uncovered: false };
}

function collectApiFailures(error: unknown): GitHubApiError[] {
  if (error instanceof GitHubPullRequestEndpointsError) {
    return error.failures;
  }
  if (error instanceof GitHubApiError) {
    return [error];
  }
  return [];
}
