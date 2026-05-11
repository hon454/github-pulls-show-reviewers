import {
  bootAccessBanner,
  type AccessBannerHandle,
} from "../src/features/access-banner";
import type {
  BannerFailureInfo,
  BannerKind,
} from "../src/features/access-banner/aggregator";
import { isHigherPriority } from "../src/features/access-banner/aggregator";
import { bootReviewerListPage } from "../src/features/reviewers";
import { parsePullListRoute } from "../src/github/routes";
import {
  type ReviewerFetchFailure,
  extractReviewerFetchFailures,
} from "../src/runtime/reviewer-fetch";

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
          onRowFailure({ account, error }) {
            if (aggregator == null) {
              aggregator = bootAccessBanner(ctx);
            }
            if (aggregator == null) {
              return;
            }

            const classified = classifyRowFailure(error, account);
            if (classified == null) {
              console.warn(
                "[ghpsr] Unclassified reviewer-fetch failure; banner suppressed.",
                error,
              );
              return;
            }
            if (classified.info == null) {
              aggregator.reportFailure(classified.kind);
            } else {
              aggregator.reportFailure(classified.kind, classified.info);
            }
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

type ClassifiedRowFailure = {
  kind: BannerKind;
  info?: BannerFailureInfo;
};

function classifyRowFailure(
  error: unknown,
  account: { id?: string } | null,
): ClassifiedRowFailure | null {
  const failures = extractReviewerFetchFailures(error);
  if (failures.length === 0) {
    return null;
  }

  let best: ClassifiedRowFailure | null = null;
  for (const failure of failures) {
    const kind = classifyFailure(failure, account);
    if (kind == null) continue;
    if (best != null && !isHigherPriority(kind, best.kind)) {
      if (
        kind === best.kind &&
        isRateLimitKind(kind) &&
        best.info?.rateLimit == null &&
        failure.rateLimit != null
      ) {
        best = { kind, info: { rateLimit: failure.rateLimit } };
      }
      continue;
    }
    if (isRateLimitKind(kind) && failure.rateLimit != null) {
      best = { kind, info: { rateLimit: failure.rateLimit } };
    } else {
      best = { kind };
    }
  }
  return best;
}

function isRateLimitKind(kind: BannerKind): boolean {
  return kind === "auth-rate-limit" || kind === "unauth-rate-limit";
}

function classifyFailure(
  failure: ReviewerFetchFailure,
  account: { id?: string } | null,
): BannerKind | null {
  const isRateLimited = failure.rateLimited || failure.status === 429;

  if (account != null) {
    if (failure.status === 401) {
      return "auth-expired";
    }
    if (isRateLimited) {
      return "auth-rate-limit";
    }
    if (failure.status === 404 || failure.status === 403) {
      return "app-uncovered";
    }
    return null;
  }

  if (isRateLimited) {
    return "unauth-rate-limit";
  }
  if (
    failure.status === 401 ||
    failure.status === 403 ||
    failure.status === 404
  ) {
    return "signin-required";
  }
  return null;
}
