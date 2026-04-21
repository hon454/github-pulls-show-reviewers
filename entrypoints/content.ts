import { bootAccessBanner } from "../src/features/access-banner";
import { bootReviewerListPage } from "../src/features/reviewers";

export default defineContentScript({
  matches: ["https://github.com/*/*"],
  runAt: "document_idle",
  main(ctx) {
    let aggregator = bootAccessBanner(ctx);

    const refreshAccessBanner = () => {
      aggregator?.teardown();
      aggregator = bootAccessBanner(ctx);
    };

    ctx.addEventListener(window, "wxt:locationchange", refreshAccessBanner);
    ctx.addEventListener(window, "popstate", refreshAccessBanner);
    ctx.addEventListener(document, "turbo:render", refreshAccessBanner);
    ctx.addEventListener(document, "pjax:end", refreshAccessBanner);

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
