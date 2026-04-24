export type BannerRepo = { owner: string; name: string };

export type BannerState = {
  uncovered: boolean;
  unauthRateLimited: boolean;
  dismissed: boolean;
  repo: BannerRepo;
};

export type BannerAggregator = {
  getState(): BannerState;
  subscribe(listener: (state: BannerState) => void): () => void;
  reportUncovered(): void;
  reportUnauthRateLimit(): void;
  dismiss(): void;
};

export function createBannerAggregator(options: {
  pathname: string;
  repo: BannerRepo;
}): BannerAggregator {
  const dismissKey = `ghpsr:banner-dismissed:${options.pathname}`;
  const repo = options.repo;
  let uncovered = false;
  let unauthRateLimited = false;
  let dismissed = readDismissed(dismissKey);
  const listeners = new Set<(state: BannerState) => void>();

  function snapshot(): BannerState {
    return {
      uncovered,
      unauthRateLimited,
      dismissed,
      repo,
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
    reportUncovered() {
      if (uncovered) {
        return;
      }
      uncovered = true;
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
  uncovered: boolean;
  unauthRateLimited: boolean;
  repo: BannerRepo;
}): string {
  if (state.uncovered) {
    return `Add ${state.repo.owner}/${state.repo.name} to @${state.repo.owner}'s GitHub App installation to see reviewers on this page.`;
  }
  if (state.unauthRateLimited) {
    return "You hit GitHub's unauthenticated rate limit.";
  }
  return "";
}
