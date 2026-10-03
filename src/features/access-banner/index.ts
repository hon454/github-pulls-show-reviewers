import { getLocaleStore } from "../../i18n/browser";

import type { ContentScriptContext } from "wxt/utils/content-script-context";

import {
  buildInstallAppUrl,
  readGitHubAppConfig,
} from "../../config/github-app";
import { parsePullListRoute } from "../../github/routes";
import { githubSelectors } from "../../github/selectors";
import type { OpenOptionsPageMessage } from "../../runtime/options-page";

import { createBannerAggregator, type BannerAggregator } from "./aggregator";
import { mountBanner, type BannerAnchor, type BannerMount } from "./dom";

export type AccessBannerHandle = BannerAggregator & {
  refreshMount(): void;
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
    // parsePullListRoute returns { owner, repo }; BannerRepo uses `name` to
    // avoid the awkward `repo.repo` path when reading the state later.
    repo: { owner: route.owner, name: route.repo },
  });

  const optionsPageUrl = browser.runtime.getURL("/options.html");
  const appConfigResult = readGitHubAppConfig();
  if (!appConfigResult.ok) {
    return null;
  }
  const appConfig = appConfigResult.config;
  const installUrl = buildInstallAppUrl(appConfig.slug);

  function openOptionsPage(): void {
    const message: OpenOptionsPageMessage = { type: "openOptionsPage" };
    browser.runtime.sendMessage(message).catch((error) => {
      console.warn(
        "[ghpsr] Failed to open options page from access banner.",
        error,
      );
    });
  }

  let mount: BannerMount | null = null;
  let mountAnchor: BannerAnchor | null = null;

  function findAnchor(): BannerAnchor | null {
    for (const { selector, position } of githubSelectors.accessBannerAnchors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element != null) return { element, position };
    }
    return null;
  }

  function isSameAnchor(next: BannerAnchor | null): boolean {
    return (
      next?.element === mountAnchor?.element &&
      next?.position === mountAnchor?.position
    );
  }

  const localeStore = getLocaleStore();
  const render = () => {
    const state = aggregator.getState();
    const anchor = findAnchor();
    if (!isSameAnchor(anchor)) {
      mount?.teardown();
      mount = null;
      mountAnchor = anchor;
    }
    if (mount == null) {
      if (anchor == null) {
        return;
      }
      mount = mountBanner({
        anchor: anchor.element,
        position: anchor.position,
        installUrl,
        optionsPageUrl,
        onOpenOptionsPage: openOptionsPage,
        onDismiss: () => aggregator.dismiss(),
      });
    }
    mount.update(state, localeStore.getSnapshot());
  };
  const unsubscribeLocale = localeStore.subscribe(render);
  const unsubscribe = aggregator.subscribe(render);

  const teardown = () => {
    unsubscribe();
    unsubscribeLocale();
    mount?.teardown();
    mount = null;
  };

  ctx.onInvalidated(() => {
    teardown();
  });

  return {
    ...aggregator,
    refreshMount() {
      if (
        !isSameAnchor(findAnchor()) ||
        (mount != null && !mount.isConnected())
      )
        render();
    },
    teardown,
  };
}
