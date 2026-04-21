import type { ContentScriptContext } from "wxt/utils/content-script-context";

import { buildInstallAppUrl, getGitHubAppConfig } from "../../config/github-app";
import { parsePullListRoute } from "../../github/routes";

import { createBannerAggregator, type BannerAggregator } from "./aggregator";
import { mountBanner, type BannerMount } from "./dom";

export type AccessBannerHandle = BannerAggregator & {
  teardown(): void;
};

export function bootAccessBanner(
  ctx: ContentScriptContext,
): AccessBannerHandle | null {
  const route = parsePullListRoute(window.location.pathname);
  if (route == null) {
    return null;
  }
  const aggregator = createBannerAggregator({
    pathname: window.location.pathname,
  });

  const optionsPageUrl = browser.runtime.getURL("/options.html");
  const appConfig = getGitHubAppConfig();
  const installUrl = buildInstallAppUrl(appConfig.slug);

  let mount: BannerMount | null = null;

  function ensureMountTarget(): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>(".pr-toolbar") ??
      document.querySelector<HTMLElement>(".subnav") ??
      document.querySelector<HTMLElement>("main") ??
      null
    );
  }

  const unsubscribe = aggregator.subscribe((state) => {
    if (mount == null) {
      const target = ensureMountTarget();
      if (target == null) {
        return;
      }
      mount = mountBanner({
        insertAfter: target,
        installUrl,
        optionsPageUrl,
        onDismiss: () => aggregator.dismiss(),
      });
    }
    mount.update(state);
  });

  const teardown = () => {
    unsubscribe();
    mount?.teardown();
    mount = null;
  };

  ctx.onInvalidated(() => {
    teardown();
  });

  return {
    ...aggregator,
    teardown,
  };
}
