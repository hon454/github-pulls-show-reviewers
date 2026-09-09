import { z } from "zod";

export const LIVE_CANARY_SAMPLE_LIMIT = 3;

export type CanaryRepository = {
  owner: string;
  repo: string;
};

export type CanaryCollectionCompleteness =
  | "complete"
  | "truncated"
  | "unavailable";

export type CanaryReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED";

export type CanaryPullMetadata = {
  pullNumber: string;
  authorLogin: string;
  requestedUsers: string[];
  requestedTeams: string[];
};

export type CanaryReview = {
  login: string;
  state: CanaryReviewState;
  submittedAt: string | null;
  index: number;
};

export type CanaryReviewRequestEvent = {
  login: string;
  createdAt: string;
  index: number;
};

export type CanaryPullEvidence = {
  pullNumber: string;
  metadata: CanaryPullMetadata | null;
  reviews: {
    completeness: CanaryCollectionCompleteness;
    items: CanaryReview[];
  };
  reviewRequests: {
    completeness: CanaryCollectionCompleteness;
    items: CanaryReviewRequestEvent[];
  };
};

export type CanaryRateLimit = {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
  resource: string | null;
};

export type CanaryEndpointKind =
  | "pull-list"
  | "pull"
  | "reviews"
  | "issue-events";

export type CanaryEndpointObservation = {
  kind: CanaryEndpointKind;
  pullNumber: string | null;
  page: number;
  status: number;
  body: "pending" | "parsed" | "failed";
  failure: "body-read" | "body-timeout" | "schema" | null;
  rateLimit: CanaryRateLimit;
};

export type CanaryApiEvidence = {
  apiRequestCount: number;
  apiRequestsWithAuthorization: number;
  targetApiResponseCount: number;
  endpoints: CanaryEndpointObservation[];
  pulls: CanaryPullEvidence[];
};

export type CanaryRequestLike = {
  url(): string;
  headers(): Record<string, string>;
};

export type CanaryResponseLike = {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  json(): Promise<unknown>;
};

export type CanaryResponseObserver = {
  observeRequest(request: CanaryRequestLike): void;
  observeResponse(response: CanaryResponseLike): void;
  settle(): Promise<void>;
  snapshot(): CanaryApiEvidence;
};

type ParsedEndpoint = {
  kind: CanaryEndpointKind;
  pullNumber: string | null;
  page: number;
};

type PageEvidence<T> = {
  page: number;
  hasNext: boolean;
  linkValid: boolean;
  items: T[];
};

type PullAccumulator = {
  metadata: CanaryPullMetadata | null;
  reviewPages: Map<number, PageEvidence<CanaryReview>>;
  eventPages: Map<number, PageEvidence<CanaryReviewRequestEvent>>;
  reviewFailure: boolean;
  eventFailure: boolean;
};

const userSchema = z.object({ login: z.string().min(1) }).passthrough();
const metadataSchema = z
  .object({
    number: z.number().int().positive().optional(),
    user: userSchema,
    requested_reviewers: z.array(userSchema).default([]),
    requested_teams: z
      .array(z.object({ slug: z.string().min(1) }).passthrough())
      .default([]),
  })
  .passthrough();
const reviewSchema = z
  .object({
    state: z.string(),
    submitted_at: z.string().nullable().optional(),
    user: userSchema.nullable(),
  })
  .passthrough();
const reviewRequestEventSchema = z
  .object({
    event: z.string(),
    created_at: z.string(),
    requested_reviewer: userSchema.nullable().optional(),
  })
  .passthrough();

export function createCanaryResponseObserver(input: {
  repository: CanaryRepository;
  bodyTimeoutMs?: number;
}): CanaryResponseObserver {
  const bodyTimeoutMs = input.bodyTimeoutMs ?? 15_000;
  const endpoints: CanaryEndpointObservation[] = [];
  const pulls = new Map<string, PullAccumulator>();
  const pending = new Set<Promise<void>>();
  let apiRequestCount = 0;
  let apiRequestsWithAuthorization = 0;
  let targetApiResponseCount = 0;

  const getPull = (pullNumber: string): PullAccumulator => {
    let pull = pulls.get(pullNumber);
    if (pull == null) {
      pull = {
        metadata: null,
        reviewPages: new Map(),
        eventPages: new Map(),
        reviewFailure: false,
        eventFailure: false,
      };
      pulls.set(pullNumber, pull);
    }
    return pull;
  };

  const markEndpointFailure = (endpoint: ParsedEndpoint): void => {
    if (endpoint.pullNumber == null) return;
    const pull = getPull(endpoint.pullNumber);
    if (endpoint.kind === "reviews") pull.reviewFailure = true;
    if (endpoint.kind === "issue-events") pull.eventFailure = true;
  };

  return {
    observeRequest(request): void {
      if (!isGitHubApiUrl(request.url())) return;
      apiRequestCount += 1;
      const headers = lowerCaseHeaders(request.headers());
      if (headers.authorization != null) apiRequestsWithAuthorization += 1;
    },

    observeResponse(response): void {
      const endpoint = parseTargetApiEndpoint(response.url(), input.repository);
      if (endpoint == null) return;

      targetApiResponseCount += 1;
      const headers = lowerCaseHeaders(response.headers());
      const observation: CanaryEndpointObservation = {
        ...endpoint,
        status: response.status(),
        body: "pending",
        failure: null,
        rateLimit: readRateLimit(headers),
      };
      endpoints.push(observation);

      if (response.status() < 200 || response.status() >= 300) {
        // Error bodies are neither needed nor retained; status and quota are
        // sufficient to classify the endpoint as unverifiable.
        observation.body = "parsed";
        markEndpointFailure(endpoint);
        return;
      }

      const read = readObservedBody(response, bodyTimeoutMs)
        .then((body) => {
          recordBody({
            endpoint,
            headers,
            body,
            getPull,
          });
          observation.body = "parsed";
        })
        .catch((error: unknown) => {
          observation.body = "failed";
          observation.failure = classifyBodyFailure(error);
          markEndpointFailure(endpoint);
        });
      pending.add(read);
      void read.finally(() => pending.delete(read));
    },

    async settle(): Promise<void> {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },

    snapshot(): CanaryApiEvidence {
      return {
        apiRequestCount,
        apiRequestsWithAuthorization,
        targetApiResponseCount,
        endpoints: endpoints.map((endpoint) => ({
          ...endpoint,
          rateLimit: { ...endpoint.rateLimit },
        })),
        pulls: [...pulls.entries()]
          .sort(([left], [right]) => Number(left) - Number(right))
          .map(([pullNumber, pull]) => ({
            pullNumber,
            metadata:
              pull.metadata == null
                ? null
                : {
                    ...pull.metadata,
                    requestedUsers: [...pull.metadata.requestedUsers],
                    requestedTeams: [...pull.metadata.requestedTeams],
                  },
            reviews: summarizePages(pull.reviewPages, pull.reviewFailure),
            reviewRequests: summarizePages(pull.eventPages, pull.eventFailure),
          })),
      };
    },
  };
}

function recordBody(input: {
  endpoint: ParsedEndpoint;
  headers: Record<string, string>;
  body: unknown;
  getPull(pullNumber: string): PullAccumulator;
}): void {
  const { endpoint } = input;
  if (endpoint.kind === "pull-list") {
    const parsed = z.array(metadataSchema).safeParse(input.body);
    if (!parsed.success) throw new CanaryBodyError("schema");
    for (const item of parsed.data) {
      if (item.number == null) continue;
      const pullNumber = String(item.number);
      input.getPull(pullNumber).metadata = toMetadata(pullNumber, item);
    }
    return;
  }

  if (endpoint.pullNumber == null) throw new CanaryBodyError("schema");
  const pull = input.getPull(endpoint.pullNumber);
  if (endpoint.kind === "pull") {
    const parsed = metadataSchema.safeParse(input.body);
    if (!parsed.success) throw new CanaryBodyError("schema");
    pull.metadata = toMetadata(endpoint.pullNumber, parsed.data);
    return;
  }

  const pagination = readPagination(input.headers.link);
  if (endpoint.kind === "reviews") {
    const parsed = z.array(reviewSchema).safeParse(input.body);
    if (!parsed.success) throw new CanaryBodyError("schema");
    const items = parsed.data.flatMap((item, index) => {
      const state = normalizeReviewState(item.state);
      return state == null || item.user == null
        ? []
        : [
            {
              login: item.user.login,
              state,
              submittedAt: item.submitted_at ?? null,
              index: endpoint.page * 100_000 + index,
            },
          ];
    });
    pull.reviewPages.set(endpoint.page, {
      page: endpoint.page,
      hasNext: pagination.hasNext,
      linkValid: pagination.valid,
      items,
    });
    return;
  }

  const parsed = z.array(reviewRequestEventSchema).safeParse(input.body);
  if (!parsed.success) throw new CanaryBodyError("schema");
  const items = parsed.data.flatMap((item, index) =>
    item.event === "review_requested" && item.requested_reviewer != null
      ? [
          {
            login: item.requested_reviewer.login,
            createdAt: item.created_at,
            index: endpoint.page * 100_000 + index,
          },
        ]
      : [],
  );
  pull.eventPages.set(endpoint.page, {
    page: endpoint.page,
    hasNext: pagination.hasNext,
    linkValid: pagination.valid,
    items,
  });
}

function toMetadata(
  pullNumber: string,
  value: z.infer<typeof metadataSchema>,
): CanaryPullMetadata {
  return {
    pullNumber,
    authorLogin: value.user.login,
    requestedUsers: value.requested_reviewers.map((user) => user.login),
    requestedTeams: value.requested_teams.map((team) => team.slug),
  };
}

function summarizePages<T>(
  pages: Map<number, PageEvidence<T>>,
  failed: boolean,
): { completeness: CanaryCollectionCompleteness; items: T[] } {
  const ordered = [...pages.values()].sort(
    (left, right) => left.page - right.page,
  );
  const items = ordered.flatMap((page) => page.items);
  if (failed) return { completeness: "unavailable", items };
  if (ordered.length === 0) return { completeness: "unavailable", items };
  const isContiguous = ordered.every(
    (page, index) => page.page === index + 1 && page.linkValid,
  );
  const last = ordered.at(-1)!;
  return {
    completeness: isContiguous && !last.hasNext ? "complete" : "truncated",
    items,
  };
}

function parseTargetApiEndpoint(
  value: string,
  repository: CanaryRepository,
): ParsedEndpoint | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!isGitHubApiUrl(url.href)) return null;
  const owner = escapeRegExp(repository.owner);
  const repo = escapeRegExp(repository.repo);
  const base = `/repos/${owner}/${repo}`;
  const flags = "i";
  if (new RegExp(`^${base}/pulls/?$`, flags).test(url.pathname)) {
    return { kind: "pull-list", pullNumber: null, page: readPage(url) };
  }
  let match = new RegExp(`^${base}/pulls/(\\d+)/reviews/?$`, flags).exec(
    url.pathname,
  );
  if (match != null) {
    return { kind: "reviews", pullNumber: match[1], page: readPage(url) };
  }
  match = new RegExp(`^${base}/issues/(\\d+)/events/?$`, flags).exec(
    url.pathname,
  );
  if (match != null) {
    return {
      kind: "issue-events",
      pullNumber: match[1],
      page: readPage(url),
    };
  }
  match = new RegExp(`^${base}/pulls/(\\d+)/?$`, flags).exec(url.pathname);
  return match == null
    ? null
    : { kind: "pull", pullNumber: match[1], page: readPage(url) };
}

function isGitHubApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.github.com" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function readPage(url: URL): number {
  const parsed = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function readPagination(link: string | undefined): {
  hasNext: boolean;
  valid: boolean;
} {
  if (link == null || link.trim() === "")
    return { hasNext: false, valid: true };
  let hasNext = false;
  for (const segment of link.split(",")) {
    const match = /<[^>]+>\s*;[^,]*\brel="([^"]+)"(?:\s*;[^,]*)?\s*$/.exec(
      segment.trim(),
    );
    if (match == null) return { hasNext: false, valid: false };
    const relations = match[1].trim().split(/\s+/).filter(Boolean);
    if (relations.length === 0) return { hasNext: false, valid: false };
    if (relations.includes("next")) hasNext = true;
  }
  return { hasNext, valid: true };
}

function lowerCaseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function readRateLimit(headers: Record<string, string>): CanaryRateLimit {
  return {
    limit: readHeaderNumber(headers["x-ratelimit-limit"]),
    remaining: readHeaderNumber(headers["x-ratelimit-remaining"]),
    reset: readHeaderNumber(headers["x-ratelimit-reset"]),
    resource: headers["x-ratelimit-resource"] ?? null,
  };
}

function readHeaderNumber(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeReviewState(value: string): CanaryReviewState | null {
  const state = value.toUpperCase();
  return state === "APPROVED" ||
    state === "CHANGES_REQUESTED" ||
    state === "COMMENTED" ||
    state === "DISMISSED"
    ? state
    : null;
}

class CanaryBodyError extends Error {
  constructor(public readonly reason: "schema" | "body-timeout") {
    super(reason);
  }
}

async function readObservedBody(
  response: CanaryResponseLike,
  timeoutMs: number,
): Promise<unknown> {
  const body = response.json();
  void body.catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      body,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new CanaryBodyError("body-timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}

function classifyBodyFailure(
  error: unknown,
): "body-read" | "body-timeout" | "schema" {
  return error instanceof CanaryBodyError ? error.reason : "body-read";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type CanaryActualReviewer = {
  kind: "user" | "team";
  identifier: string;
  state: CanaryReviewState | null;
  ring:
    | "requested"
    | "approved"
    | "changes-requested"
    | "commented"
    | "dismissed"
    | "team"
    | "unknown";
  badge:
    | "refresh"
    | "approved"
    | "changes-requested"
    | "commented"
    | "dismissed"
    | null;
  qualifier: string | null;
};

export type CanaryDomRow = {
  pullNumber: string;
  hostLinkCount: number;
  productionMatchCount: number;
  mountCount: number;
  loadingMountCount: number;
  renderedMountCount: number;
  invalidReviewerChipCount: number;
  reviewers: CanaryActualReviewer[];
};

export type CanaryDomSnapshot = {
  mainFound: boolean;
  pullListContainerFound: boolean;
  hostEmptySignalFound: boolean;
  hostListLoading: boolean;
  unmatchedPullListLinkCount: number;
  orphanMountCount: number;
  challengeDetected: boolean;
  ignoredPullLinkCount: number;
  activeFailureBannerCount: number;
  hostPullNumbers: string[];
  productionPullNumbers: string[];
  rows: CanaryDomRow[];
};

/**
 * A zero-row result is terminal only when GitHub has rendered a semantic empty
 * state. A bare or busy list container can be a transient navigation frame.
 */
export function isTerminalCanaryDomSnapshot(dom: CanaryDomSnapshot): boolean {
  if (dom.hostPullNumbers.length === 0) {
    return (
      dom.mainFound &&
      dom.pullListContainerFound &&
      dom.hostEmptySignalFound &&
      !dom.hostListLoading &&
      dom.unmatchedPullListLinkCount === 0 &&
      dom.orphanMountCount === 0
    );
  }
  return dom.rows.every(
    (row) => row.mountCount === 1 && row.loadingMountCount === 0,
  );
}

/**
 * Self-contained so Playwright can serialize it directly into the page. The
 * denominator is exact PR links inside main issue_N rows, never the production
 * row selector passed only for the coverage comparison.
 */
export function collectLiveCanaryDomSnapshot(input: {
  repository: CanaryRepository;
  productionRowSelector: string;
}): CanaryDomSnapshot {
  const main = document.querySelector("main");
  const stateFromTitle = (value: string | null): CanaryReviewState | null => {
    if (value == null) return null;
    const normalized = value.toLowerCase();
    if (normalized.includes("changes requested")) return "CHANGES_REQUESTED";
    if (normalized.includes("approved")) return "APPROVED";
    if (normalized.includes("commented")) return "COMMENTED";
    if (normalized.includes("dismissed")) return "DISMISSED";
    return null;
  };
  const parsePullNumber = (href: string | null): string | null => {
    if (href == null) return null;
    try {
      const url = new URL(href, "https://github.com");
      if (url.origin !== "https://github.com") return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (
        parts.length !== 4 ||
        parts[0].toLowerCase() !== input.repository.owner.toLowerCase() ||
        parts[1].toLowerCase() !== input.repository.repo.toLowerCase() ||
        parts[2] !== "pull" ||
        !/^\d+$/.test(parts[3])
      )
        return null;
      return parts[3];
    } catch {
      return null;
    }
  };
  const readQualifier = (href: string | null): string | null => {
    if (href == null) return null;
    try {
      const url = new URL(href, "https://github.com");
      if (
        url.origin !== "https://github.com" ||
        url.pathname.toLowerCase() !==
          `/${input.repository.owner}/${input.repository.repo}/pulls`.toLowerCase()
      )
        return null;
      const query = url.searchParams.get("q");
      return (
        query
          ?.split(/\s+/)
          .find((part) =>
            /^(?:review-requested|reviewed-by|team-review-requested):/i.test(
              part,
            ),
          ) ?? null
      );
    } catch {
      return null;
    }
  };
  const readRing = (element: Element): CanaryActualReviewer["ring"] => {
    const value = element.className;
    if (/--(?:border-)?requested(?:\s|$)/.test(value)) return "requested";
    if (/--(?:border-)?changes-requested(?:\s|$)/.test(value))
      return "changes-requested";
    if (/--(?:border-)?approved(?:\s|$)/.test(value)) return "approved";
    if (/--(?:border-)?commented(?:\s|$)/.test(value)) return "commented";
    if (/--(?:border-)?dismissed(?:\s|$)/.test(value)) return "dismissed";
    return "unknown";
  };
  const readBadge = (element: Element): CanaryActualReviewer["badge"] => {
    const badge = element.querySelector(".ghpsr-badge");
    if (badge == null) return null;
    const value = badge.className;
    if (value.includes("ghpsr-badge--refresh")) return "refresh";
    if (value.includes("ghpsr-badge--changes-requested"))
      return "changes-requested";
    if (value.includes("ghpsr-badge--approved")) return "approved";
    if (value.includes("ghpsr-badge--commented")) return "commented";
    if (value.includes("ghpsr-badge--dismissed")) return "dismissed";
    return null;
  };
  const parseReviewer = (element: Element): CanaryActualReviewer | null => {
    const qualifier = readQualifier(element.getAttribute("href"));
    const match =
      /^(review-requested|reviewed-by|team-review-requested):(.+)$/i.exec(
        qualifier ?? "",
      );
    if (match == null) return null;
    if (match[1].toLowerCase() === "team-review-requested") {
      const identifier = match[2].split("/").at(-1);
      return identifier == null
        ? null
        : {
            kind: "team",
            identifier: identifier.toLowerCase(),
            state: null,
            ring: "team",
            badge: null,
            qualifier: qualifier?.toLowerCase() ?? null,
          };
    }
    return {
      kind: "user",
      identifier: match[2].toLowerCase(),
      state: stateFromTitle(
        element.getAttribute("title") ?? element.getAttribute("aria-label"),
      ),
      ring: readRing(element),
      badge: readBadge(element),
      qualifier: qualifier?.toLowerCase() ?? null,
    };
  };

  const challengeDetected =
    document.querySelector(
      'iframe[src*="captcha" i], [data-testid*="captcha" i], #captcha, form[action*="verified" i]',
    ) != null ||
    /verify (?:you are|that you're) human|abuse detection|captcha/i.test(
      document.title,
    ) ||
    /you have triggered an abuse detection mechanism/i.test(
      document.body?.textContent?.slice(0, 1_000) ?? "",
    );
  const activeFailureBannerCount = [
    ...document.querySelectorAll<HTMLElement>("[data-ghpsr-banner]"),
  ].filter(
    (banner) =>
      !banner.hidden &&
      banner.getAttribute("aria-hidden") !== "true" &&
      banner.style.display !== "none",
  ).length;
  if (main == null) {
    return {
      mainFound: false,
      pullListContainerFound: false,
      hostEmptySignalFound: false,
      hostListLoading: false,
      unmatchedPullListLinkCount: 0,
      orphanMountCount: 0,
      challengeDetected,
      ignoredPullLinkCount: 0,
      activeFailureBannerCount,
      hostPullNumbers: [],
      productionPullNumbers: [],
      rows: [],
    };
  }

  // This is deliberately independent from the production row selector. A
  // present list container with no PR links is a normal empty result; a bare
  // main region with neither rows nor the list container is selector/host
  // evidence failure, not a silently accepted empty list.
  const pullListContainer = main.querySelector(
    ".js-navigation-container, [data-testid='issues-list']",
  );
  const pullListContainerFound = pullListContainer != null;
  const hostListLoading =
    pullListContainer?.matches("[aria-busy='true'], [data-loading='true']") ===
      true ||
    pullListContainer?.querySelector(
      "[aria-busy='true'], [data-loading='true']",
    ) != null;
  const hostEmptySignalFound =
    !hostListLoading &&
    [...(pullListContainer?.querySelectorAll(
      "[data-testid='empty-state'], .blankslate, [class*='Blankslate']",
    ) ?? [])].some(
      (element) =>
        !element.hasAttribute("hidden") &&
        element.getAttribute("aria-hidden") !== "true",
    );

  const hostRows = new Map<string, { row: Element; links: Set<Element> }>();
  let ignoredPullLinkCount = 0;
  let unmatchedPullListLinkCount = 0;
  main.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
    const pullNumber = parsePullNumber(link.getAttribute("href"));
    if (pullNumber == null) return;
    const row = link.closest(`[id="issue_${pullNumber}"]`);
    if (row == null || !main.contains(row)) {
      // Exact PR links in prose, advertising, or other main-page content are
      // intentionally outside the pull-list denominator.
      ignoredPullLinkCount += 1;
      if (pullListContainer?.contains(link)) unmatchedPullListLinkCount += 1;
      return;
    }
    const existing = hostRows.get(pullNumber) ?? { row, links: new Set() };
    existing.links.add(link);
    hostRows.set(pullNumber, existing);
  });

  const productionPullNumbers: string[] = [];
  const productionCounts = new Map<string, number>();
  document.querySelectorAll(input.productionRowSelector).forEach((row) => {
    const idMatch = /^issue_(\d+)$/.exec(row.getAttribute("id") ?? "");
    let pullNumber = idMatch?.[1] ?? null;
    if (pullNumber == null) {
      for (const link of row.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        pullNumber = parsePullNumber(link.getAttribute("href"));
        if (pullNumber != null) break;
      }
    }
    if (pullNumber == null) return;
    productionPullNumbers.push(pullNumber);
    productionCounts.set(
      pullNumber,
      (productionCounts.get(pullNumber) ?? 0) + 1,
    );
  });

  const rows = [...hostRows.entries()].map(([pullNumber, value]) => {
    const mounts = [...value.row.querySelectorAll("[data-ghpsr-root]")];
    const reviewerChips = mounts.flatMap((mount) => [
      ...mount.querySelectorAll(
        "a.ghpsr-avatar, a.ghpsr-pill, a.ghpsr-chip--team",
      ),
    ]);
    const parsedReviewers = reviewerChips.map((element) =>
      parseReviewer(element),
    );
    const reviewers = parsedReviewers.filter(
      (reviewer): reviewer is CanaryActualReviewer => reviewer != null,
    );
    return {
      pullNumber,
      hostLinkCount: value.links.size,
      productionMatchCount: productionCounts.get(pullNumber) ?? 0,
      mountCount: mounts.length,
      loadingMountCount: mounts.filter(
        (mount) => mount.querySelector(".ghpsr-status") != null,
      ).length,
      renderedMountCount: mounts.filter(
        (mount) => mount.getAttribute("data-ghpsr-rendered") === "1",
      ).length,
      invalidReviewerChipCount: parsedReviewers.length - reviewers.length,
      reviewers,
    };
  });
  const orphanMountCount = [
    ...main.querySelectorAll<HTMLElement>("[data-ghpsr-root]"),
  ].filter(
    (mount) => ![...hostRows.values()].some(({ row }) => row.contains(mount)),
  ).length;

  return {
    mainFound: true,
    pullListContainerFound,
    hostEmptySignalFound,
    hostListLoading,
    unmatchedPullListLinkCount,
    orphanMountCount,
    challengeDetected,
    ignoredPullLinkCount,
    activeFailureBannerCount,
    hostPullNumbers: rows.map((row) => row.pullNumber),
    productionPullNumbers,
    rows,
  };
}

export type CanaryExpectedReviewer = CanaryActualReviewer & {
  requestEvidence: "not-needed" | "confirmed" | "unverified" | null;
};

export type CanaryExpectedOutcome = {
  pullNumber: string;
  reviewers: CanaryExpectedReviewer[];
  completeForSampling: boolean;
  unverifiable: string[];
};

type LatestReview = CanaryReview;

export function deriveCanaryExpectedOutcome(
  evidence: CanaryPullEvidence,
  repository: CanaryRepository,
): CanaryExpectedOutcome {
  const unverifiable: string[] = [];
  if (evidence.metadata == null) unverifiable.push("metadata-missing");
  if (evidence.reviews.completeness !== "complete")
    unverifiable.push(`reviews-${evidence.reviews.completeness}`);
  if (
    evidence.metadata == null ||
    evidence.reviews.completeness !== "complete"
  ) {
    return {
      pullNumber: evidence.pullNumber,
      reviewers: [],
      completeForSampling: false,
      unverifiable,
    };
  }

  const author = evidence.metadata.authorLogin.toLowerCase();
  const latestNonComment = new Map<string, LatestReview>();
  const latestComment = new Map<string, LatestReview>();
  for (const review of evidence.reviews.items) {
    const login = review.login.toLowerCase();
    if (login === author) continue;
    const target =
      review.state === "COMMENTED" ? latestComment : latestNonComment;
    const existing = target.get(login);
    if (existing == null || isNewerReview(review, existing))
      target.set(login, review);
  }

  const latestRequests = new Map<string, CanaryReviewRequestEvent>();
  const incomparableRequestLogins = new Set<string>();
  for (const event of evidence.reviewRequests.items) {
    const login = event.login.toLowerCase();
    if (parseTimestamp(event.createdAt) == null) {
      incomparableRequestLogins.add(login);
      continue;
    }
    const existing = latestRequests.get(login);
    if (existing == null || isNewerRequest(event, existing))
      latestRequests.set(login, event);
  }

  const requested = new Set(
    evidence.metadata.requestedUsers.map((login) => login.toLowerCase()),
  );
  const logins = new Set([
    ...requested,
    ...latestNonComment.keys(),
    ...latestComment.keys(),
  ]);
  let hasAmbiguousRequest = false;
  const users: CanaryExpectedReviewer[] = [];
  for (const login of logins) {
    const nonComment = latestNonComment.get(login) ?? null;
    const completed = nonComment ?? latestComment.get(login) ?? null;
    let isRequested = requested.has(login);
    let requestEvidence: CanaryExpectedReviewer["requestEvidence"] = null;
    if (isRequested && nonComment != null) {
      hasAmbiguousRequest = true;
      const comparison = compareRequestToReview(
        latestRequests.get(login)?.createdAt ?? null,
        nonComment.submittedAt,
      );
      if (comparison === "after") requestEvidence = "confirmed";
      else if (
        comparison === "not-after" &&
        !incomparableRequestLogins.has(login) &&
        evidence.reviewRequests.completeness === "complete"
      ) {
        isRequested = false;
      } else requestEvidence = "unverified";
    } else if (isRequested) requestEvidence = "not-needed";

    const state = completed?.state ?? null;
    const ring = isRequested
      ? "requested"
      : state == null
        ? "unknown"
        : stateToClass(state);
    const badge = isRequested
      ? requestEvidence === "confirmed" &&
        state != null &&
        state !== "COMMENTED"
        ? "refresh"
        : null
      : state == null
        ? null
        : stateToClass(state);
    users.push({
      kind: "user",
      identifier: login,
      state,
      ring,
      badge,
      qualifier: `${isRequested ? "review-requested" : "reviewed-by"}:${login}`,
      requestEvidence,
    });
  }

  const teams: CanaryExpectedReviewer[] = evidence.metadata.requestedTeams.map(
    (slug) => ({
      kind: "team",
      identifier: slug.toLowerCase(),
      state: null,
      ring: "team",
      badge: null,
      qualifier: `team-review-requested:${repository.owner.toLowerCase()}/${slug.toLowerCase()}`,
      requestEvidence: "not-needed",
    }),
  );

  return {
    pullNumber: evidence.pullNumber,
    reviewers: [...users, ...teams],
    completeForSampling:
      !hasAmbiguousRequest ||
      evidence.reviewRequests.completeness === "complete",
    unverifiable,
  };
}

function isNewerReview(left: CanaryReview, right: CanaryReview): boolean {
  const leftTime = parseTimestamp(left.submittedAt);
  const rightTime = parseTimestamp(right.submittedAt);
  if (leftTime != null && rightTime != null) return leftTime >= rightTime;
  if (leftTime != null) return true;
  if (rightTime != null) return false;
  return left.index >= right.index;
}

function isNewerRequest(
  left: CanaryReviewRequestEvent,
  right: CanaryReviewRequestEvent,
): boolean {
  const leftTime = parseTimestamp(left.createdAt);
  const rightTime = parseTimestamp(right.createdAt);
  if (leftTime != null && rightTime != null) return leftTime >= rightTime;
  if (leftTime != null) return true;
  if (rightTime != null) return false;
  return left.index >= right.index;
}

function compareRequestToReview(
  requestedAt: string | null,
  reviewedAt: string | null,
): "after" | "not-after" | "incomparable" {
  const requestTime = parseTimestamp(requestedAt);
  const reviewTime = parseTimestamp(reviewedAt);
  if (requestTime == null || reviewTime == null) return "incomparable";
  return requestTime > reviewTime ? "after" : "not-after";
}

function parseTimestamp(value: string | null): number | null {
  if (value == null) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match == null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] == null ? 0 : Number(match[8]);
  const offsetMinute = match[9] == null ? 0 : Number(match[9]);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    daysInMonth == null ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function stateToClass(
  state: CanaryReviewState,
): "approved" | "changes-requested" | "commented" | "dismissed" {
  if (state === "APPROVED") return "approved";
  if (state === "CHANGES_REQUESTED") return "changes-requested";
  if (state === "COMMENTED") return "commented";
  return "dismissed";
}

export type CanaryFailure = {
  owner: "extension" | "environment" | "observation";
  code: string;
  pullNumber: string | null;
};

export type CanaryVerifiedSample = {
  pullNumber: string;
  expected: CanaryExpectedReviewer[];
  actual: CanaryActualReviewer[];
};

export type CanaryVerdict = {
  ok: boolean;
  failures: CanaryFailure[];
  terminal: {
    loading: number;
    empty: number;
    success: number;
    failure: number;
    unverifiable: number;
  };
  samples: CanaryVerifiedSample[];
};

export function appendCanaryFailure(
  verdict: CanaryVerdict,
  failure: CanaryFailure | undefined,
): CanaryVerdict {
  if (
    failure == null ||
    verdict.failures.some(
      (existing) =>
        existing.owner === failure.owner &&
        existing.code === failure.code &&
        existing.pullNumber === failure.pullNumber,
    )
  )
    return failure == null ? verdict : { ...verdict, ok: false };
  return { ...verdict, ok: false, failures: [...verdict.failures, failure] };
}

export function evaluateLiveCanary(input: {
  repository: CanaryRepository;
  dom: CanaryDomSnapshot;
  api: CanaryApiEvidence;
}): CanaryVerdict {
  const failures: CanaryFailure[] = [];
  const terminal = {
    loading: 0,
    empty: 0,
    success: 0,
    failure: 0,
    unverifiable: 0,
  };
  const fail = (
    owner: CanaryFailure["owner"],
    code: string,
    pullNumber: string | null = null,
  ): void => {
    if (
      !failures.some(
        (failure) =>
          failure.owner === owner &&
          failure.code === code &&
          failure.pullNumber === pullNumber,
      )
    )
      failures.push({ owner, code, pullNumber });
  };

  const hasConfirmedEmptyHost =
    input.dom.mainFound &&
    input.dom.pullListContainerFound &&
    input.dom.hostEmptySignalFound &&
    !input.dom.hostListLoading &&
    input.dom.hostPullNumbers.length === 0 &&
    input.dom.unmatchedPullListLinkCount === 0;
  const hasVerifiedEmptyList =
    hasConfirmedEmptyHost && input.dom.orphanMountCount === 0;

  if (!input.dom.mainFound) fail("environment", "main-region-missing");
  if (input.dom.challengeDetected) fail("environment", "github-challenge");
  if (input.dom.activeFailureBannerCount > 0)
    fail("extension", "failure-banner-present");
  if (input.dom.unmatchedPullListLinkCount > 0)
    fail("environment", "host-pull-row-unmatched");
  if (input.dom.orphanMountCount > 0)
    fail(
      "extension",
      hasConfirmedEmptyHost ? "empty-list-mount" : "orphan-mount-present",
    );
  if (input.dom.hostPullNumbers.length === 0 && !hasVerifiedEmptyList)
    fail(
      "environment",
      input.dom.hostListLoading
        ? "host-pull-list-loading"
        : "host-pull-rows-missing",
    );
  if (input.api.apiRequestCount === 0 && !hasVerifiedEmptyList)
    fail("extension", "public-api-request-missing");
  if (input.api.apiRequestsWithAuthorization > 0)
    fail("extension", "authorization-header-present");
  for (const endpoint of input.api.endpoints) {
    if (endpoint.status < 200 || endpoint.status >= 300) {
      fail(
        endpoint.status === 429 || endpoint.status >= 500
          ? "environment"
          : "observation",
        endpoint.status === 429
          ? "api-rate-limited"
          : endpoint.status >= 500
            ? "api-server-error"
            : "api-http-error",
        endpoint.pullNumber,
      );
    }
    if (endpoint.body === "failed")
      fail(
        "observation",
        `api-${endpoint.failure ?? "body-read"}`,
        endpoint.pullNumber,
      );
    if (endpoint.body === "pending")
      fail("observation", "api-body-pending", endpoint.pullNumber);
  }

  const hostSet = new Set(input.dom.hostPullNumbers);
  const productionSet = new Set(input.dom.productionPullNumbers);
  if (
    hostSet.size !== productionSet.size ||
    [...hostSet].some((pullNumber) => !productionSet.has(pullNumber))
  )
    fail("extension", "production-selector-coverage");

  const evidenceByPull = new Map(
    input.api.pulls.map((pull) => [pull.pullNumber, pull]),
  );
  const sampleCandidates: Array<{
    row: CanaryDomRow;
    outcome: CanaryExpectedOutcome;
  }> = [];
  for (const row of input.dom.rows) {
    if (row.productionMatchCount !== 1)
      fail("extension", "production-row-duplicate-or-missing", row.pullNumber);
    if (row.mountCount !== 1) {
      terminal.failure += 1;
      fail("extension", "mount-count", row.pullNumber);
      continue;
    }
    if (row.loadingMountCount > 0) {
      terminal.loading += 1;
      fail("extension", "loading-not-settled", row.pullNumber);
      continue;
    }
    if (row.invalidReviewerChipCount > 0) {
      terminal.failure += 1;
      fail("extension", "invalid-reviewer-chip", row.pullNumber);
      continue;
    }

    const evidence = evidenceByPull.get(row.pullNumber);
    if (evidence == null) {
      terminal.unverifiable += 1;
      fail("observation", "pull-evidence-missing", row.pullNumber);
      continue;
    }
    const outcome = deriveCanaryExpectedOutcome(evidence, input.repository);
    if (outcome.unverifiable.length > 0) {
      terminal.unverifiable += 1;
      for (const reason of outcome.unverifiable)
        fail("observation", reason, row.pullNumber);
      continue;
    }

    if (outcome.reviewers.length === 0 && row.reviewers.length === 0)
      terminal.empty += 1;
    else if (outcome.reviewers.length > 0 && row.reviewers.length > 0)
      terminal.success += 1;
    else {
      terminal.failure += 1;
      fail("extension", "terminal-outcome-mismatch", row.pullNumber);
    }
    if (outcome.completeForSampling) sampleCandidates.push({ row, outcome });
  }

  const withReviewers = sampleCandidates.filter(
    ({ row }) => row.reviewers.length > 0,
  );
  const empty = sampleCandidates.filter(
    ({ outcome }) => outcome.reviewers.length === 0,
  );
  if (withReviewers.length === 0 && !hasVerifiedEmptyList)
    fail("environment", "reviewer-sample-missing");
  const selected = [
    ...withReviewers.slice(0, 1),
    ...empty.slice(0, 1),
    ...withReviewers.slice(1),
    ...empty.slice(1),
  ].slice(0, LIVE_CANARY_SAMPLE_LIMIT);
  const samples = selected.map(({ row, outcome }) => ({
    pullNumber: row.pullNumber,
    expected: outcome.reviewers,
    actual: row.reviewers,
  }));
  for (const sample of samples) {
    if (!reviewerListsMatch(sample.expected, sample.actual))
      fail("extension", "reviewer-outcome-mismatch", sample.pullNumber);
  }

  return { ok: failures.length === 0, failures, terminal, samples };
}

function reviewerListsMatch(
  expected: CanaryExpectedReviewer[],
  actual: CanaryActualReviewer[],
): boolean {
  const signature = (reviewer: CanaryActualReviewer): string =>
    [
      reviewer.kind,
      reviewer.identifier.toLowerCase(),
      reviewer.state ?? "",
      reviewer.ring,
      reviewer.badge ?? "",
      reviewer.qualifier?.toLowerCase() ?? "",
    ].join("|");
  return (
    expected.length === actual.length &&
    expected.map(signature).sort().join("\n") ===
      actual.map(signature).sort().join("\n")
  );
}

export type CanaryNavigationObservation = {
  stage: string;
  operation: string;
  previousUrl: string | null;
  documentMaintained: boolean | null;
};

export function isDifferentPullListPage(
  candidateUrl: URL,
  currentUrl: string,
): boolean {
  const candidatePage = candidateUrl.searchParams.get("page");
  const currentPage = new URL(currentUrl).searchParams.get("page") ?? "1";
  return candidatePage != null && candidatePage !== currentPage;
}

export function sameCanaryPullNumberSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((pullNumber) => rightSet.has(pullNumber))
  );
}

export type CanaryDomCapture = {
  source: "current-document" | "unavailable";
};

export function createCanaryDiagnostics(input: {
  phase: string;
  repository: CanaryRepository;
  targetUrl: string;
  currentUrl: string;
  responseStatus: number | null;
  dom: CanaryDomSnapshot;
  api: CanaryApiEvidence;
  verdict: CanaryVerdict;
  navigation?: CanaryNavigationObservation;
  domCapture?: CanaryDomCapture;
}): object {
  return {
    phase: input.phase,
    repository: `${input.repository.owner}/${input.repository.repo}`,
    targetUrl: input.targetUrl,
    currentUrl: input.currentUrl,
    responseStatus: input.responseStatus,
    domCapture: input.domCapture ?? { source: "current-document" },
    ...(input.navigation == null ? {} : { navigation: input.navigation }),
    host: {
      mainFound: input.dom.mainFound,
      pullListContainerFound: input.dom.pullListContainerFound,
      emptySignalFound: input.dom.hostEmptySignalFound,
      listLoading: input.dom.hostListLoading,
      unmatchedPullListLinkCount: input.dom.unmatchedPullListLinkCount,
      challengeDetected: input.dom.challengeDetected,
      independentRowCount: input.dom.hostPullNumbers.length,
      productionRowCount: new Set(input.dom.productionPullNumbers).size,
      pullNumbers: input.dom.hostPullNumbers,
      ignoredPullLinkCount: input.dom.ignoredPullLinkCount,
      activeFailureBannerCount: input.dom.activeFailureBannerCount,
    },
    mounts: {
      total: input.dom.rows.reduce((sum, row) => sum + row.mountCount, 0),
      loading: input.dom.rows.reduce(
        (sum, row) => sum + row.loadingMountCount,
        0,
      ),
      rendered: input.dom.rows.reduce(
        (sum, row) => sum + row.renderedMountCount,
        0,
      ),
      invalidReviewerChips: input.dom.rows.reduce(
        (sum, row) => sum + row.invalidReviewerChipCount,
        0,
      ),
      orphaned: input.dom.orphanMountCount,
    },
    terminal: input.verdict.terminal,
    api: {
      requestCount: input.api.apiRequestCount,
      requestsWithAuthorization: input.api.apiRequestsWithAuthorization,
      targetResponseCount: input.api.targetApiResponseCount,
      endpoints: input.api.endpoints,
    },
    samples: input.verdict.samples,
    failures: input.verdict.failures,
  };
}
