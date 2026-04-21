export type BannerState = {
  uncoveredOrgs: string[];
  unauthRateLimited: boolean;
  dismissed: boolean;
};

export type BannerAggregator = {
  getState(): BannerState;
  subscribe(listener: (state: BannerState) => void): () => void;
  reportUncoveredOwner(owner: string): void;
  reportUnauthRateLimit(): void;
  dismiss(): void;
};

export function createBannerAggregator(options: {
  pathname: string;
}): BannerAggregator {
  const dismissKey = `ghpsr:banner-dismissed:${options.pathname}`;
  const orgs = new Set<string>();
  let unauthRateLimited = false;
  let dismissed = readDismissed(dismissKey);
  const listeners = new Set<(state: BannerState) => void>();

  function snapshot(): BannerState {
    return {
      uncoveredOrgs: [...orgs],
      unauthRateLimited,
      dismissed,
    };
  }

  function emit(): void {
    const state = snapshot();
    listeners.forEach((listener) => listener(state));
  }

  return {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
      };
    },
    reportUncoveredOwner(owner) {
      const normalized = owner.toLowerCase();
      if (orgs.has(normalized)) {
        return;
      }
      orgs.add(normalized);
      emit();
    },
    reportUnauthRateLimit() {
      if (unauthRateLimited) {
        return;
      }
      unauthRateLimited = true;
      emit();
    },
    dismiss() {
      if (dismissed) {
        return;
      }
      dismissed = true;
      try {
        window.sessionStorage.setItem(dismissKey, "1");
      } catch {
        // sessionStorage access denied — ignore
      }
      emit();
    },
  };
}

function readDismissed(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function formatBannerMessage(state: {
  uncoveredOrgs: string[];
  unauthRateLimited: boolean;
}): string {
  if (state.uncoveredOrgs.length === 1) {
    return `Add GitHub App access to @${state.uncoveredOrgs[0]} to see reviewers on this page.`;
  }
  if (state.uncoveredOrgs.length > 1) {
    const [first, ...rest] = state.uncoveredOrgs;
    return `Add GitHub App access to @${first} and ${rest.length} more organization${rest.length === 1 ? "" : "s"}.`;
  }
  if (state.unauthRateLimited) {
    return "You hit GitHub's unauthenticated rate limit.";
  }
  return "";
}
