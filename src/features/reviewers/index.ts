import type { ContentScriptContext } from "wxt/client";

import { parsePullListRoute } from "~/github/routes";

export function bootReviewerListPage(ctx: ContentScriptContext): void {
  const route = parsePullListRoute(window.location.pathname);
  if (route == null) {
    return;
  }

  const marker = `[GitHub Pulls Show Reviewers] Initialized on ${route.owner}/${route.repo}`;
  console.info(marker);

  ctx.addEventListener(window, "popstate", () => {
    const nextRoute = parsePullListRoute(window.location.pathname);
    if (nextRoute == null) {
      return;
    }

    console.info(
      `[GitHub Pulls Show Reviewers] Navigated to ${nextRoute.owner}/${nextRoute.repo}`,
    );
  });
}
