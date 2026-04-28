export type BannerRepo = { readonly owner: string; readonly name: string };

export type BannerKind =
  | "auth-expired"
  | "app-uncovered"
  | "auth-rate-limit"
  | "unauth-rate-limit"
  | "signin-required";

export type BannerRateLimitSnapshot = {
  limit: number | null;
  remaining: number | null;
  resource: string | null;
  resetAt: number | null;
};

export type BannerFailureInfo = {
  rateLimit?: BannerRateLimitSnapshot;
};

export type BannerState = {
  current: BannerKind | null;
  dismissed: boolean;
  repo: BannerRepo;
  rateLimit?: BannerRateLimitSnapshot;
};

export type BannerAggregator = {
  getState(): BannerState;
  subscribe(listener: (state: BannerState) => void): () => void;
  reportFailure(kind: BannerKind, info?: BannerFailureInfo): void;
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
  let rateLimit: BannerRateLimitSnapshot | undefined;
  let dismissed = readDismissed(options.pathname, current);
  const listeners = new Set<(state: BannerState) => void>();

  function snapshot(): BannerState {
    return rateLimit == null
      ? { current, dismissed, repo }
      : { current, dismissed, repo, rateLimit };
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
    reportFailure(kind, info) {
      if (kind === current) {
        // Same kind already active: keep the first non-empty rate-limit
        // snapshot we received and avoid emitting a no-op.
        if (rateLimit == null && info?.rateLimit != null) {
          rateLimit = info.rateLimit;
          emit();
        }
        return;
      }
      if (!isHigherPriority(kind, current)) {
        return;
      }
      current = kind;
      // Only carry rate-limit info on rate-limit kinds; clear it for others.
      rateLimit =
        kind === "auth-rate-limit" || kind === "unauth-rate-limit"
          ? info?.rateLimit
          : undefined;
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
  state: Pick<BannerState, "current" | "repo" | "rateLimit">,
  options?: { now?: () => number },
): string {
  switch (state.current) {
    case "auth-expired":
      return "Your GitHub session expired. Sign in again to keep loading reviewers.";
    case "app-uncovered":
      return `Add ${state.repo.owner}/${state.repo.name} to @${state.repo.owner}'s GitHub App installation to see reviewers on this page.`;
    case "auth-rate-limit": {
      const usage = formatUsageClause(state.rateLimit);
      const reset = formatResetClause(state.rateLimit, options?.now);
      const usageSegment = usage ? ` ${usage}` : "";
      const resetSegment = reset
        ? ` Reviewers will resume ${reset}.`
        : " Reviewers will resume automatically when the limit resets.";
      return `GitHub's hourly request limit was reached.${usageSegment}${resetSegment}`;
    }
    case "unauth-rate-limit": {
      const usage = formatUsageClause(state.rateLimit);
      const reset = formatResetClause(state.rateLimit, options?.now);
      const usageSegment = usage
        ? ` ${usage}`
        : " (60/hr unauthenticated cap)";
      const resetSegment = reset ? ` Resets ${reset}.` : "";
      return `GitHub's unauthenticated request limit was reached.${usageSegment} Sign in to raise it to 5,000/hr.${resetSegment}`;
    }
    case "signin-required":
      return "Sign in with GitHub to see reviewers on private repositories.";
    case null:
      return "";
  }
}

function formatUsageClause(
  rateLimit: BannerRateLimitSnapshot | undefined,
): string {
  if (
    rateLimit?.limit == null ||
    rateLimit.remaining == null ||
    rateLimit.limit <= 0
  ) {
    return "";
  }
  const used = Math.max(0, rateLimit.limit - rateLimit.remaining);
  return `(${used}/${rateLimit.limit} used)`;
}

function formatResetClause(
  rateLimit: BannerRateLimitSnapshot | undefined,
  now?: () => number,
): string {
  if (rateLimit?.resetAt == null) {
    return "";
  }
  const resetAtMs = rateLimit.resetAt * 1000;
  const nowMs = (now ?? Date.now)();
  const deltaMs = resetAtMs - nowMs;
  if (deltaMs <= 0) {
    return "shortly";
  }
  const minutes = Math.ceil(deltaMs / 60_000);
  if (minutes <= 1) {
    return "in about 1 minute";
  }
  if (minutes < 60) {
    return `in about ${minutes} minutes`;
  }
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "in about 1 hour" : `in about ${hours} hours`;
}
