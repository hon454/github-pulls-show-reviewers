import { disposeUIClient } from "../src/runtime/ui-client";
import { DISCOVERY_DOCUMENT_PROBE } from "../src/runtime/repository-discovery";
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
import type { ReviewerFailure } from "../src/features/reviewers/outcomes";
import { parsePullListRoute } from "../src/github/routes";
import {
  type ReviewerFetchFailure,
  extractReviewerFetchFailures,
} from "../src/runtime/reviewer-fetch";

export default defineContentScript({
  matches: ["https://github.com/*/*"],
  runAt: "document_idle",
  main(ctx) {
    const documentProbe: Parameters<
      typeof browser.runtime.onMessage.addListener
    >[0] = (message, sender, reply) => {
      if (
        sender.id === browser.runtime.id &&
        message?.type === DISCOVERY_DOCUMENT_PROBE
      )
        reply({ alive: !ctx.isInvalid });
      return undefined;
    };
    browser.runtime.onMessage?.addListener(documentProbe);
    ctx.onInvalidated(() =>
      browser.runtime.onMessage?.removeListener(documentProbe),
    );
    let aggregator: AccessBannerHandle | null = null;
    let reviewerListBooted = false;
    let bannerPathname: string | null = null;
    let latestGeneration = -1;
    const classifiedFailures = new WeakMap<
      ReviewerFailure,
      ClassifiedRowFailure
    >();

    const syncBannerRoute = () => {
      const pathname = window.location.pathname;
      if (bannerPathname !== pathname) {
        aggregator?.teardown();
        aggregator = null;
        bannerPathname = pathname;
      }
      if (aggregator == null && parsePullListRoute(pathname) != null)
        aggregator = bootAccessBanner(ctx);
      aggregator?.refreshMount();
    };

    const syncRouteFeatures = () => {
      syncBannerRoute();
      if (parsePullListRoute(window.location.pathname) == null) return;
      if (!reviewerListBooted) {
        reviewerListBooted = true;
        bootReviewerListPage(ctx, {
          onOutcomes(snapshot) {
            if (
              snapshot.generation < latestGeneration ||
              snapshot.pathname !== window.location.pathname
            )
              return;
            latestGeneration = snapshot.generation;
            // The controller may receive a route event before this entrypoint.
            // Synchronize the banner before applying that route's result set.
            syncBannerRoute();
            const failures = new Set<ClassifiedRowFailure>();
            for (const { outcome } of snapshot.rows) {
              if (outcome.status !== "failure") continue;
              let classified = classifiedFailures.get(outcome.failure);
              if (classified == null) {
                classified = classifyRowFailure(
                  outcome.failure.error,
                  outcome.failure.account,
                );
                classifiedFailures.set(outcome.failure, classified);
              }
              failures.add(classified);
            }
            aggregator?.reconcile({
              generation: snapshot.generation,
              pending: snapshot.rows.some(
                ({ outcome }) => outcome.status === "pending",
              ),
              failures: [...failures],
            });
          },
        });
      }
    };

    syncRouteFeatures();
    ctx.onInvalidated(disposeUIClient);

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
): ClassifiedRowFailure {
  const failures = extractReviewerFetchFailures(error);
  if (failures.length === 0) {
    return { kind: "reviewers-unavailable" };
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
  return best ?? { kind: "reviewers-unavailable" };
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
