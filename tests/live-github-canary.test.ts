// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectLiveCanaryDomSnapshot,
  createCanaryDiagnostics,
  createCanaryResponseObserver,
  deriveCanaryExpectedOutcome,
  evaluateLiveCanary,
  type CanaryApiEvidence,
  type CanaryDomSnapshot,
  type CanaryPullEvidence,
  type CanaryRepository,
  type CanaryResponseLike,
} from "./helpers/live-github-canary";

const repository: CanaryRepository = { owner: "octo", repo: "repo" };

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("live canary host-row oracle", () => {
  it("uses deduplicated main-list PR links instead of the production selector", () => {
    document.body.innerHTML = `
      <aside><div id="issue_100"><a href="/octo/repo/pull/100">outside</a></div></aside>
      <main>
        <div class="js-issue-row" id="issue_42">
          <a href="/octo/repo/pull/42">title</a>
          <a href="https://github.com/octo/repo/pull/42">number</a>
          <span data-ghpsr-root></span>
        </div>
        <div id="issue_43">
          <a href="/octo/repo/pull/43">selector drift fixture</a>
          <span data-ghpsr-root></span>
        </div>
        <article><a href="/octo/repo/pull/99">body reference</a></article>
        <a href="/octo/repo/pull/42/files">not a direct PR link</a>
      </main>`;

    const snapshot = collectDom();

    expect(snapshot.hostPullNumbers).toEqual(["42", "43"]);
    expect(snapshot.rows[0].hostLinkCount).toBe(2);
    expect(snapshot.productionPullNumbers).toEqual(["42"]);
    expect(snapshot.ignoredPullLinkCount).toBe(1);
  });

  it("marks a challenge without retaining delivered page text", () => {
    document.title = "Verify you are human";
    document.body.innerHTML = "<main><form id='captcha'></form></main>";

    expect(collectDom().challengeDetected).toBe(true);
  });
});

describe("live canary response observer", () => {
  it("waits for every asynchronous body read before exposing parsed evidence", async () => {
    const metadata = deferred<unknown>();
    const reviews = deferred<unknown>();
    const observer = createCanaryResponseObserver({ repository });
    observer.observeResponse(
      response(
        "https://api.github.com/repos/octo/repo/pulls?per_page=100",
        metadata.promise,
      ),
    );
    observer.observeResponse(
      response(
        "https://api.github.com/repos/octo/repo/pulls/42/reviews?per_page=100",
        reviews.promise,
      ),
    );

    expect(
      observer.snapshot().endpoints.map((endpoint) => endpoint.body),
    ).toEqual(["pending", "pending"]);
    const settled = observer.settle();
    let didSettle = false;
    void settled.then(() => {
      didSettle = true;
    });
    await Promise.resolve();
    expect(didSettle).toBe(false);

    metadata.resolve([
      {
        number: 42,
        user: { login: "author" },
        requested_reviewers: [],
        requested_teams: [],
      },
    ]);
    reviews.resolve([]);
    await settled;

    const snapshot = observer.snapshot();
    expect(snapshot.endpoints.map((endpoint) => endpoint.body)).toEqual([
      "parsed",
      "parsed",
    ]);
    expect(snapshot.pulls[0].reviews.completeness).toBe("complete");
  });

  it("classifies delayed rejection and timeout without an early success", async () => {
    const rejected = createCanaryResponseObserver({ repository });
    rejected.observeResponse(
      response(
        "https://api.github.com/repos/octo/repo/pulls/42/reviews",
        Promise.reject(new Error("body unavailable")),
      ),
    );
    await rejected.settle();
    expect(rejected.snapshot().endpoints[0]).toMatchObject({
      body: "failed",
      failure: "body-read",
    });

    const never = deferred<unknown>();
    const timedOut = createCanaryResponseObserver({
      repository,
      bodyTimeoutMs: 1,
    });
    timedOut.observeResponse(
      response(
        "https://api.github.com/repos/octo/repo/pulls/42/reviews",
        never.promise,
      ),
    );
    await timedOut.settle();
    expect(timedOut.snapshot().endpoints[0]).toMatchObject({
      body: "failed",
      failure: "body-timeout",
    });
    never.reject(new Error("closed after observer timeout"));
  });

  it("collects partial pagination and marks complete only after the final page", async () => {
    const observer = createCanaryResponseObserver({ repository });
    observer.observeResponse(
      response(
        "https://api.github.com/repos/octo/repo/issues/42/events?per_page=100",
        Promise.resolve([
          {
            event: "review_requested",
            created_at: "2026-09-01T00:00:00Z",
            requested_reviewer: { login: "alice" },
          },
        ]),
        200,
        {
          link: '<https://api.github.com/repos/octo/repo/issues/42/events?per_page=100&page=2>; rel="next"',
        },
      ),
    );
    await observer.settle();
    expect(observer.snapshot().pulls[0].reviewRequests).toMatchObject({
      completeness: "truncated",
      items: [{ login: "alice" }],
    });

    observer.observeResponse(
      response(
        "https://api.github.com/repos/octo/repo/issues/42/events?per_page=100&page=2",
        Promise.resolve([]),
      ),
    );
    await observer.settle();
    expect(observer.snapshot().pulls[0].reviewRequests.completeness).toBe(
      "complete",
    );
  });

  it("does not treat a malformed Link relation as complete pagination", async () => {
    const observer = createCanaryResponseObserver({ repository });
    observer.observeResponse(
      response(
        "https://api.github.com/repos/octo/repo/pulls/42/reviews?per_page=100",
        Promise.resolve([]),
        200,
        {
          link: '<https://api.github.com/repos/octo/repo/pulls/42/reviews?page=2>; rel: "next"',
        },
      ),
    );
    await observer.settle();

    expect(observer.snapshot().pulls[0].reviews.completeness).toBe("truncated");
  });

  it("keeps an external AbortError body failure explicit", async () => {
    const observer = createCanaryResponseObserver({ repository });
    observer.observeResponse(
      response(
        "https://api.github.com/repos/octo/repo/pulls/42/reviews",
        Promise.reject(new DOMException("cancelled", "AbortError")),
      ),
    );
    await observer.settle();

    expect(observer.snapshot().endpoints[0]).toMatchObject({
      body: "failed",
      failure: "body-read",
    });
    expect(observer.snapshot().pulls[0].reviews.completeness).toBe(
      "unavailable",
    );
  });

  it("never sends a request and never retains an authorization value or raw body", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const observer = createCanaryResponseObserver({ repository });
    observer.observeRequest({
      url: () => "https://api.github.com/repos/octo/repo/pulls/42/reviews",
      headers: () => ({ Authorization: "Bearer PRIVATE_FIXTURE_VALUE" }),
    });
    observer.observeResponse(
      response(
        "https://api.github.com/repos/octo/repo/pulls/42/reviews",
        Promise.resolve([
          {
            state: "APPROVED",
            submitted_at: "2026-09-01T00:00:00Z",
            user: { login: "public-reviewer", private_field: "DO_NOT_KEEP" },
          },
        ]),
        200,
        {
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "59",
          "x-secret-header": "DO_NOT_KEEP_EITHER",
        },
      ),
    );
    await observer.settle();

    const serialized = JSON.stringify(observer.snapshot());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(serialized).not.toContain("PRIVATE_FIXTURE_VALUE");
    expect(serialized).not.toContain("DO_NOT_KEEP");
    expect(serialized).not.toContain("DO_NOT_KEEP_EITHER");
    expect(observer.snapshot()).toMatchObject({
      apiRequestCount: 1,
      apiRequestsWithAuthorization: 1,
      endpoints: [{ rateLimit: { limit: 60, remaining: 59 } }],
    });
  });

  it("does not read or retain a failed endpoint body", () => {
    const json = vi.fn(async () => ({ secret: "never read" }));
    const observer = createCanaryResponseObserver({ repository });
    observer.observeResponse({
      ...response(
        "https://api.github.com/repos/octo/repo/pulls/42/reviews",
        Promise.resolve([]),
        500,
      ),
      json,
    });

    expect(json).not.toHaveBeenCalled();
    expect(JSON.stringify(observer.snapshot())).not.toContain("never read");
  });
});

describe("independent reviewer expectation oracle", () => {
  it("excludes the author, prefers a non-comment review, and removes stale requested only with complete dated evidence", () => {
    const outcome = deriveCanaryExpectedOutcome(
      pullEvidence({
        requestedUsers: ["alice"],
        requestedTeams: ["platform"],
        reviews: [
          review("author", "CHANGES_REQUESTED", "2026-09-04T00:00:00Z", 0),
          review("alice", "APPROVED", "2026-09-02T00:00:00Z", 1),
          review("alice", "COMMENTED", "2026-09-03T00:00:00Z", 2),
        ],
        eventCompleteness: "complete",
        events: [requestEvent("alice", "2026-09-01T00:00:00Z", 0)],
      }),
      repository,
    );

    expect(outcome.completeForSampling).toBe(true);
    expect(outcome.reviewers).toEqual([
      expect.objectContaining({
        kind: "user",
        identifier: "alice",
        state: "APPROVED",
        requestEvidence: null,
        ring: "approved",
        badge: "approved",
        qualifier: "reviewed-by:alice",
      }),
      expect.objectContaining({
        kind: "team",
        identifier: "platform",
        qualifier: "team-review-requested:octo/platform",
      }),
    ]);
  });

  it("confirms a directly observed later request even when event history is partial", () => {
    const outcome = deriveCanaryExpectedOutcome(
      pullEvidence({
        requestedUsers: ["alice"],
        reviews: [review("alice", "APPROVED", "2026-09-01T00:00:00Z", 0)],
        eventCompleteness: "truncated",
        events: [requestEvent("alice", "2026-09-02T00:00:00Z", 0)],
      }),
      repository,
    );

    expect(outcome.completeForSampling).toBe(false);
    expect(outcome.reviewers[0]).toMatchObject({
      requestEvidence: "confirmed",
      ring: "requested",
      badge: "refresh",
      qualifier: "review-requested:alice",
    });
  });

  it.each([
    ["unavailable history", "unavailable", [], "2026-09-01T00:00:00Z"],
    ["no event", "complete", [], "2026-09-01T00:00:00Z"],
    [
      "incomparable date",
      "complete",
      [requestEvent("alice", "not-a-date", 0)],
      "2026-09-01T00:00:00Z",
    ],
    [
      "missing review date",
      "complete",
      [requestEvent("alice", "2026-09-02T00:00:00Z", 0)],
      null,
    ],
    [
      "mixed comparable and incomparable events",
      "complete",
      [
        requestEvent("alice", "2026-08-31T00:00:00Z", 0),
        requestEvent("alice", "not-a-date", 1),
      ],
      "2026-09-01T00:00:00Z",
    ],
    [
      "calendar-normalized invalid event date",
      "complete",
      [requestEvent("alice", "2026-02-30T00:00:00Z", 0)],
      "2026-02-28T00:00:00Z",
    ],
    [
      "calendar-normalized invalid review date",
      "complete",
      [requestEvent("alice", "2026-03-01T00:00:00Z", 0)],
      "2026-02-30T00:00:00Z",
    ],
  ] as const)(
    "keeps requested unverified for %s",
    (_name, completeness, events, reviewedAt) => {
      const outcome = deriveCanaryExpectedOutcome(
        pullEvidence({
          requestedUsers: ["alice"],
          reviews: [review("alice", "APPROVED", reviewedAt, 0)],
          eventCompleteness: completeness,
          events: [...events],
        }),
        repository,
      );

      expect(outcome.reviewers[0]).toMatchObject({
        requestEvidence: "unverified",
        ring: "requested",
        badge: null,
        qualifier: "review-requested:alice",
      });
    },
  );
});

describe("live canary verdict", () => {
  it("accepts a rendered reviewer row and a verified empty row", () => {
    const verdict = evaluateLiveCanary({
      repository,
      dom: positiveDom(),
      api: positiveApi(),
    });

    expect(verdict).toMatchObject({
      ok: true,
      terminal: { success: 1, empty: 1, loading: 0, failure: 0 },
    });
    expect(verdict.samples.map((sample) => sample.pullNumber)).toEqual([
      "42",
      "43",
    ]);
  });

  it("fails a mounted row whose loading state never settles", () => {
    const dom = positiveDom();
    dom.rows[0].loadingMountCount = 1;

    expect(failureCodes(dom, positiveApi())).toContain("loading-not-settled");
  });

  it("does not accept list metadata success when reviews fail", () => {
    const api = positiveApi();
    api.endpoints.push({
      kind: "reviews",
      pullNumber: "42",
      page: 1,
      status: 500,
      body: "parsed",
      failure: null,
      rateLimit: { limit: 60, remaining: 0, reset: 1, resource: "core" },
    });
    api.pulls[0].reviews.completeness = "unavailable";

    const failures = failureCodes(positiveDom(), api);
    expect(failures).toContain("api-server-error");
    expect(failures).toContain("reviews-unavailable");
  });

  it.each([
    [
      "wrong reviewer",
      (dom: CanaryDomSnapshot) =>
        (dom.rows[0].reviewers[0].identifier = "mallory"),
    ],
    [
      "wrong state",
      (dom: CanaryDomSnapshot) =>
        (dom.rows[0].reviewers[1].state = "DISMISSED"),
    ],
    [
      "wrong search qualifier",
      (dom: CanaryDomSnapshot) =>
        (dom.rows[0].reviewers[1].qualifier = "review-requested:bob"),
    ],
  ])("distinguishes %s from a correct rendered outcome", (_name, mutate) => {
    const dom = positiveDom();
    mutate(dom);

    expect(failureCodes(dom, positiveApi())).toContain(
      "reviewer-outcome-mismatch",
    );
  });

  it("rejects duplicate mounts", () => {
    const dom = positiveDom();
    dom.rows[0].mountCount = 2;

    expect(failureCodes(dom, positiveApi())).toContain("mount-count");
  });

  it("rejects a production selector that misses an independently found row", () => {
    const dom = positiveDom();
    dom.productionPullNumbers = ["42"];
    dom.rows[1].productionMatchCount = 0;

    const failures = failureCodes(dom, positiveApi());
    expect(failures).toContain("production-selector-coverage");
    expect(failures).toContain("production-row-duplicate-or-missing");
  });

  it("fails with no complete reviewer-bearing sample and caps diagnostics at three samples", () => {
    const api = positiveApi();
    api.pulls[0].reviews.completeness = "truncated";
    const verdict = evaluateLiveCanary({ repository, dom: positiveDom(), api });
    const diagnostics = createCanaryDiagnostics({
      phase: "assertion",
      repository,
      targetUrl: "https://github.com/octo/repo/pulls?q=is%3Apr",
      currentUrl: "https://github.com/octo/repo/pulls?q=is%3Apr",
      responseStatus: 200,
      dom: positiveDom(),
      api,
      verdict,
    });

    expect(failureCodes(positiveDom(), api)).toContain(
      "reviewer-sample-missing",
    );
    expect(JSON.stringify(diagnostics)).not.toContain("headers");
    expect(verdict.samples.length).toBeLessThanOrEqual(3);
  });

  it("requires a real rendered chip even when evidence predicts one", () => {
    const dom = positiveDom();
    dom.rows[0].reviewers = [];

    const failures = failureCodes(dom, positiveApi());
    expect(failures).toContain("terminal-outcome-mismatch");
    expect(failures).toContain("reviewer-sample-missing");
  });
});

function collectDom(): CanaryDomSnapshot {
  return collectLiveCanaryDomSnapshot({
    repository,
    productionRowSelector: ".js-issue-row",
  });
}

function response(
  url: string,
  body: Promise<unknown>,
  status = 200,
  headers: Record<string, string> = {},
): CanaryResponseLike {
  return {
    url: () => url,
    status: () => status,
    headers: () => headers,
    json: () => body,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function review(
  login: string,
  state: CanaryPullEvidence["reviews"]["items"][number]["state"],
  submittedAt: string | null,
  index: number,
) {
  return { login, state, submittedAt, index };
}

function requestEvent(login: string, createdAt: string, index: number) {
  return { login, createdAt, index };
}

function pullEvidence(
  input: {
    requestedUsers?: string[];
    requestedTeams?: string[];
    reviews?: CanaryPullEvidence["reviews"]["items"];
    eventCompleteness?: CanaryPullEvidence["reviewRequests"]["completeness"];
    events?: CanaryPullEvidence["reviewRequests"]["items"];
  } = {},
): CanaryPullEvidence {
  return {
    pullNumber: "42",
    metadata: {
      pullNumber: "42",
      authorLogin: "author",
      requestedUsers: input.requestedUsers ?? [],
      requestedTeams: input.requestedTeams ?? [],
    },
    reviews: { completeness: "complete", items: input.reviews ?? [] },
    reviewRequests: {
      completeness: input.eventCompleteness ?? "unavailable",
      items: input.events ?? [],
    },
  };
}

function positiveApi(): CanaryApiEvidence {
  return {
    apiRequestCount: 3,
    apiRequestsWithAuthorization: 0,
    targetApiResponseCount: 3,
    endpoints: [
      endpoint("pull-list", null),
      endpoint("reviews", "42"),
      endpoint("reviews", "43"),
    ],
    pulls: [
      pullEvidence({
        requestedUsers: ["alice"],
        reviews: [review("bob", "APPROVED", "2026-09-01T00:00:00Z", 0)],
      }),
      {
        ...pullEvidence(),
        pullNumber: "43",
        metadata: {
          pullNumber: "43",
          authorLogin: "author",
          requestedUsers: [],
          requestedTeams: [],
        },
      },
    ],
  };
}

function endpoint(kind: "pull-list" | "reviews", pullNumber: string | null) {
  return {
    kind,
    pullNumber,
    page: 1,
    status: 200,
    body: "parsed" as const,
    failure: null,
    rateLimit: { limit: 60, remaining: 57, reset: 1, resource: "core" },
  };
}

function positiveDom(): CanaryDomSnapshot {
  return {
    mainFound: true,
    challengeDetected: false,
    ignoredPullLinkCount: 0,
    hostPullNumbers: ["42", "43"],
    productionPullNumbers: ["42", "43"],
    rows: [
      {
        pullNumber: "42",
        hostLinkCount: 1,
        productionMatchCount: 1,
        mountCount: 1,
        loadingMountCount: 0,
        renderedMountCount: 1,
        reviewers: [
          {
            kind: "user",
            identifier: "alice",
            state: null,
            ring: "requested",
            badge: null,
            qualifier: "review-requested:alice",
          },
          {
            kind: "user",
            identifier: "bob",
            state: "APPROVED",
            ring: "approved",
            badge: "approved",
            qualifier: "reviewed-by:bob",
          },
        ],
      },
      {
        pullNumber: "43",
        hostLinkCount: 1,
        productionMatchCount: 1,
        mountCount: 1,
        loadingMountCount: 0,
        renderedMountCount: 0,
        reviewers: [],
      },
    ],
  };
}

function failureCodes(
  dom: CanaryDomSnapshot,
  api: CanaryApiEvidence,
): string[] {
  return evaluateLiveCanary({ repository, dom, api }).failures.map(
    (failure) => failure.code,
  );
}
