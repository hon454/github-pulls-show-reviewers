import { createTranslator, type Translator } from "../../i18n";

export type BannerRepo = { readonly owner: string; readonly name: string };

export type BannerKind =
  | "auth-expired"
  | "app-uncovered"
  | "auth-rate-limit"
  | "unauth-rate-limit"
  | "signin-required"
  | "reviewers-unavailable";

export type BannerRateLimitSnapshot = {
  limit: number | null;
  remaining: number | null;
  resource: string | null;
  resetAt: number | null;
};

export type BannerFailureInfo = {
  rateLimit?: BannerRateLimitSnapshot;
};

export type BannerFailure = {
  kind: BannerKind;
  info?: BannerFailureInfo;
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
  reconcile(result: {
    generation: number;
    pending: boolean;
    failures: readonly BannerFailure[];
  }): void;
  dismiss(): void;
};

const PRIORITY: Record<BannerKind, number> = {
  "auth-expired": 1,
  "app-uncovered": 2,
  "auth-rate-limit": 3,
  "unauth-rate-limit": 4,
  "signin-required": 5,
  "reviewers-unavailable": 6,
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
  let generation = -1;
  let activeFailures: BannerFailure[] = [];
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
    reconcile(result) {
      if (result.generation < generation) return;
      if (result.generation !== generation) activeFailures = [];
      generation = result.generation;
      // Preserve the first current non-empty snapshot in arrival order. Shared
      // metadata failures have one identity even when they suppress many rows.
      const incoming = new Set(result.failures);
      activeFailures = activeFailures.filter((failure) =>
        incoming.has(failure),
      );
      const retained = new Set(activeFailures);
      for (const failure of incoming) {
        if (!retained.has(failure)) activeFailures.push(failure);
      }
      let best: BannerFailure | undefined;
      for (const failure of activeFailures) {
        if (
          isHigherPriority(failure.kind, best?.kind ?? null) ||
          (failure.kind === best?.kind &&
            best.info?.rateLimit == null &&
            failure.info?.rateLimit != null)
        )
          best = failure;
      }
      const next = best?.kind ?? null;
      // A pending row (including a queued request) is never recovery evidence.
      // Keep the published guidance until it can be replaced by a complete set,
      // while still allowing new, more urgent failures to appear immediately.
      if (
        result.pending &&
        (next == null || (next !== current && !isHigherPriority(next, current)))
      )
        return;
      const nextRate =
        next === "auth-rate-limit" || next === "unauth-rate-limit"
          ? best?.info?.rateLimit
          : undefined;
      if (next === current && nextRate === rateLimit) return;
      if (next !== current) dismissed = readDismissed(options.pathname, next);
      current = next;
      rateLimit = nextRate;
      emit();
    },
    dismiss() {
      if (current == null || dismissed) {
        return;
      }
      dismissed = true;
      try {
        window.sessionStorage.setItem(
          dismissKey(options.pathname, current),
          "1",
        );
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
  options?: { now?: () => number; t?: Translator },
): string {
  const t = options?.t ?? createTranslator("en");
  switch (state.current) {
    case "auth-expired":
      return t("banner_auth_expired");
    case "app-uncovered":
      return t("banner_app_uncovered", {
        repository: `${state.repo.owner}/${state.repo.name}`,
        owner: state.repo.owner,
      });
    case "signin-required":
      return t("banner_signin_required");
    case "reviewers-unavailable":
      return t("banner_reviewers_unavailable");
    case null:
      return "";
    case "auth-rate-limit":
    case "unauth-rate-limit": {
      const prefix =
        state.current === "auth-rate-limit"
          ? "banner_auth_rate"
          : "banner_unauth_rate";
      const rate = state.rateLimit;
      const usage =
        rate?.limit != null && rate.remaining != null && rate.limit > 0
          ? t("banner_usage", {
              used: Math.max(0, rate.limit - rate.remaining),
              limit: rate.limit,
            })
          : state.current === "unauth-rate-limit"
            ? t("banner_unauth_cap")
            : "";
      if (rate?.resetAt == null)
        return t(`${prefix}_unknown`, { usage }).replace(/ {2,}/g, " ");
      const deltaMs = rate.resetAt * 1000 - (options?.now ?? Date.now)();
      if (deltaMs <= 0)
        return t(`${prefix}_shortly`, { usage }).replace(/ {2,}/g, " ");
      const minutes = Math.ceil(deltaMs / 60_000);
      if (minutes <= 1)
        return t(`${prefix}_minute`, { usage }).replace(/ {2,}/g, " ");
      if (minutes < 60)
        return t(`${prefix}_minutes`, { usage, count: minutes }).replace(
          / {2,}/g,
          " ",
        );
      const hours = Math.round(minutes / 60);
      return (
        hours === 1
          ? t(`${prefix}_hour`, { usage })
          : t(`${prefix}_hours`, { usage, count: hours })
      ).replace(/ {2,}/g, " ");
    }
  }
}
