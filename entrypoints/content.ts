import {
  bootAccessBanner,
  type AccessBannerHandle,
} from "../src/features/access-banner";
import { bootReviewerListPage } from "../src/features/reviewers";
import { parsePullListRoute } from "../src/github/routes";

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
            const status = extractStatus(error);
            if (status === 429 || (account == null && status === 403)) {
              aggregator.reportUnauthRateLimit();
              return;
            }
            if (status === 404 || status === 403 || account == null) {
              aggregator.reportUncoveredOwner(owner);
              return;
            }
            // 401 and other errors — still flag uncovered so the banner can guide the user.
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
    const first = (error as { failures: Array<{ status?: number }> })
      .failures[0];
    return typeof first?.status === "number" ? first.status : null;
  }
  return null;
}
