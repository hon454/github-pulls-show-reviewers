export type BannerRepo = { readonly owner: string; readonly name: string };

export type BannerKind =
  | "auth-expired"
  | "app-uncovered"
  | "auth-rate-limit"
  | "unauth-rate-limit"
  | "signin-required";

export type BannerState = {
  current: BannerKind | null;
  dismissed: boolean;
  repo: BannerRepo;
};

export type BannerAggregator = {
  getState(): BannerState;
  subscribe(listener: (state: BannerState) => void): () => void;
  reportFailure(kind: BannerKind): void;
  dismiss(): void;
};

const PRIORITY: Record<BannerKind, number> = {
  "auth-expired": 1,
  "app-uncovered": 2,
  "auth-rate-limit": 3,
  "unauth-rate-limit": 4,
  "signin-required": 5,
};

export function isHigherPriority(
  candidate: BannerKind,
  incumbent: BannerKind | null,
): boolean {
  if (incumbent == null) {
    return true;
  }
  return PRIORITY[candidate] < PRIORITY[incumbent];
}

export function createBannerAggregator(options: {
  pathname: string;
  repo: BannerRepo;
}): BannerAggregator {
  const repo: BannerRepo = {
    owner: options.repo.owner,
    name: options.repo.name,
  };
  let current: BannerKind | null = null;
  let dismissed = readDismissed(options.pathname, current);
  const listeners = new Set<(state: BannerState) => void>();

  function snapshot(): BannerState {
    return { current, dismissed, repo };
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
    reportFailure(kind) {
      if (!isHigherPriority(kind, current)) {
        return;
      }
      current = kind;
      dismissed = readDismissed(options.pathname, current);
      emit();
    },
    dismiss() {
      if (current == null || dismissed) {
        return;
      }
      dismissed = true;
      try {
        window.sessionStorage.setItem(dismissKey(options.pathname, current), "1");
      } catch {
        // sessionStorage access denied — ignore
      }
      emit();
    },
  };
}

function dismissKey(pathname: string, kind: BannerKind | null): string {
  return `ghpsr:banner-dismissed:${pathname}:${kind ?? "none"}`;
}

function readDismissed(pathname: string, kind: BannerKind | null): boolean {
  if (kind == null) {
    return false;
  }
  try {
    return window.sessionStorage.getItem(dismissKey(pathname, kind)) === "1";
  } catch {
    return false;
  }
}

export function formatBannerMessage(
  state: Pick<BannerState, "current" | "repo">,
): string {
  switch (state.current) {
    case "auth-expired":
      return "Your GitHub session expired. Sign in again to keep loading reviewers.";
    case "app-uncovered":
      return `Add ${state.repo.owner}/${state.repo.name} to @${state.repo.owner}'s GitHub App installation to see reviewers on this page.`;
    case "auth-rate-limit":
      return "GitHub's hourly request limit was reached. Reviewers will resume automatically when the limit resets.";
    case "unauth-rate-limit":
      return "GitHub's unauthenticated request limit (60/hr) was reached. Sign in to raise it to 5,000/hr.";
    case "signin-required":
      return "Sign in with GitHub to see reviewers on private repositories.";
    case null:
      return "";
  }
}
