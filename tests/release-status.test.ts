import { describe, expect, it, vi } from "vitest";
import { executeRelease } from "../scripts/release/engine.ts";
import { resolveAction } from "../scripts/release/policy.ts";
import type { Receipt } from "../scripts/release/policy.ts";
import { GitHubProvenance } from "../scripts/release/provenance.ts";
import {
  observeRelease,
  statusReportSchema,
  statusSummary,
} from "../scripts/release/status.ts";

const target = {
  repository: "hon454/github-pulls-show-reviewers",
  sourceSha: "a".repeat(40),
  version: "1.18.2",
  publisherId: "publisher",
  itemId: "a".repeat(32),
};
const remote = {
  name: `publishers/${target.publisherId}/items/${target.itemId}`,
  itemId: target.itemId,
};
function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    ...target,
    schemaVersion: 1,
    workflowPath: ".github/workflows/release.yml",
    workflowSha: "b".repeat(40),
    runId: "100",
    runAttempt: "1",
    runUrl: `https://github.com/${target.repository}/actions/runs/100`,
    action: "upload-only",
    checked: true,
    timestamp: "2026-09-10T00:00:00.000Z",
    package: {
      artifactId: "900",
      artifactName: "chrome-package-100",
      artifactDigest: `sha256:${"c".repeat(64)}`,
      zipName: "github-pulls-show-reviewers-1.18.2-chrome.zip",
      zipSha256: "d".repeat(64),
    },
    upload: "SUCCEEDED",
    submission: "NOT_ATTEMPTED",
    outcome: "UPLOADED",
    mutationStarted: true,
    ...overrides,
  };
}
function setup(state: unknown = remote) {
  const store = {
    status: vi.fn(async () => state),
    upload: vi.fn(async () => "SUCCEEDED" as const),
    publish: vi.fn(async () => {}),
  };
  return {
    target,
    workflowSha: "b".repeat(40),
    store,
    history: vi.fn(async () => [] as { receipt: Receipt; complete: boolean }[]),
    verifyPackage: vi.fn(async () => {}),
    listing: { state: "unchanged" as const },
    now: () => new Date("2026-09-10T01:00:00.000Z"),
  };
}
const revision = (state: string, version = target.version) => ({
  state,
  distributionChannels: [{ crxVersion: version }],
});

describe("read-only release status", () => {
  it("requires an explicit exact target and never resolves status into a release", () => {
    for (const ref of ["refs/heads/main", "refs/tags/v1.18.2"]) {
      expect(
        resolveAction({
          event: "workflow_dispatch",
          ref,
          action: "status",
          sourceSha: target.sourceSha,
          expectedVersion: target.version,
        }),
      ).toEqual({
        action: "status",
        sourceRef: target.sourceSha,
        tag: "",
        createRelease: false,
      });
    }
    expect(() =>
      resolveAction({
        event: "workflow_dispatch",
        ref: "refs/heads/main",
        action: "status",
      }),
    ).toThrow();
    expect(() =>
      resolveAction({
        event: "workflow_dispatch",
        ref: "refs/heads/main",
        action: "status",
        sourceSha: target.sourceSha,
        expectedVersion: target.version,
        tag: "v1.18.2",
      }),
    ).toThrow();
  });
  it("reports an ordinary unchanged listing without browser dependencies or writes, leaving remote draft facts unknown", async () => {
    const input = setup({
      ...remote,
      publicKey: "do-not-copy",
      arbitrary: "secret",
    });
    const report = await observeRelease(input);
    expect(report.route).toBe("ordinary-release");
    expect(report.blockers).toEqual([]);
    expect(report.remote).toMatchObject({
      draftExists: "unknown",
      draftVersion: "unknown",
      draftZipSha256: "unknown",
      lastAsyncUploadState: "unknown",
      warned: "unknown",
      takenDown: "unknown",
    });
    expect(report.observedAt).toBe("2026-09-10T01:00:00.000Z");
    expect(statusReportSchema.parse(report)).toEqual(report);
    expect(JSON.stringify(report)).not.toMatch(/do-not-copy|secret/);
    expect(statusSummary(report)).toContain("not release authorization");
    expect(input.store.status).toHaveBeenCalledTimes(1);
    expect(input.store.upload).not.toHaveBeenCalled();
    expect(input.store.publish).not.toHaveBeenCalled();
    expect(input.verifyPackage).not.toHaveBeenCalled();
  });
  it.each(["changed", "missing", "conflicting"] as const)(
    "routes %s listing evidence to scoped work",
    async (state) => {
      const report = await observeRelease({ ...setup(), listing: { state } });
      expect(report.route).toBe(
        state === "changed" ? "staged-listing" : "targeted-reconciliation",
      );
      expect(report.blockers.length).toBe(state === "changed" ? 0 : 1);
    },
  );
  it.each(["pending", "published"])(
    "reuses verified %s source/package without another CWS write",
    async (kind) => {
      const input = setup({
        ...remote,
        publishedItemRevisionStatus: revision(
          "PUBLISHED",
          kind === "pending" ? "1.18.1" : target.version,
        ),
        ...(kind === "pending"
          ? { submittedItemRevisionStatus: revision("PENDING_REVIEW") }
          : {}),
      });
      input.history.mockResolvedValue([{ receipt: receipt(), complete: true }]);
      const report = await observeRelease(input);
      expect(report.route).toBe(`reuse-${kind}`);
      expect(report.remote.published?.distributionChannels[0].crxVersion).toBe(
        kind === "pending" ? "1.18.1" : target.version,
      );
      expect(report.remote.submitted?.state).toBe(
        kind === "pending" ? "PENDING_REVIEW" : undefined,
      );
      expect(input.verifyPackage).toHaveBeenCalledExactlyOnceWith(receipt());
      expect(report.receipts[0].package.zipSha256).toBe(
        receipt().package.zipSha256,
      );
      expect(input.store.upload).not.toHaveBeenCalled();
      expect(input.store.publish).not.toHaveBeenCalled();
    },
  );
  it.each(["pending", "published"] as const)(
    "keeps outstanding listing work visible when a %s package can be reused",
    async (kind) => {
      const input = setup({
        ...remote,
        ...(kind === "pending"
          ? { submittedItemRevisionStatus: revision("PENDING_REVIEW") }
          : { publishedItemRevisionStatus: revision("PUBLISHED") }),
      });
      input.history.mockResolvedValue([{ receipt: receipt(), complete: true }]);
      const report = await observeRelease({
        ...input,
        listing: { state: "changed", affectedLocales: ["ko"] },
      });
      expect(report.route).toBe(`reuse-${kind}`);
      expect(report.listing.nextAction).toContain(
        "Listing updates remain for changed locales (ko)",
      );
      expect(report.nextAction).toContain(
        "Reuse the verified original package",
      );
      expect(report.nextAction).toContain(report.listing.nextAction);
      expect(report.listing.nextAction).toContain(
        kind === "pending" ? "without cancelling" : "saved/reopened evidence",
      );
      expect(report.nextAction).not.toContain("upload-only");
      expect(report.blockers).toEqual([]);
      const summary = statusSummary(report);
      expect(summary).toContain("| Listing baseline | changed |");
      expect(summary).toContain("| Affected listing locales | ko |");
      expect(summary).toContain(report.listing.nextAction);
      expect(input.store.upload).not.toHaveBeenCalled();
      expect(input.store.publish).not.toHaveBeenCalled();
    },
  );
  it.each(["missing", "conflicting"] as const)(
    "keeps package reuse guidance alongside %s listing evidence",
    async (state) => {
      const input = setup({
        ...remote,
        publishedItemRevisionStatus: revision("PUBLISHED"),
      });
      input.history.mockResolvedValue([{ receipt: receipt(), complete: true }]);
      const report = await observeRelease({ ...input, listing: { state } });
      expect(report.route).toBe("reuse-published");
      expect(report.blockers[0].code).toBe(`listing-${state}`);
      expect(report.nextAction).toContain(
        "Reuse the verified original package",
      );
      expect(report.listing.nextAction).toContain("Reconcile saved content");
    },
  );
  it("blocks concurrent observations of an unfinished receipt run and recommends another read", async () => {
    const input = setup();
    const intent = receipt({
      outcome: "INTENT",
      upload: "NOT_ATTEMPTED",
      mutationStarted: false,
    });
    const github = new GitHubProvenance(
      target.repository,
      "fake-token",
      vi.fn(),
    );
    vi.spyOn(github, "artifacts").mockImplementation(async (name) =>
      name.startsWith("cws-intent")
        ? [
            {
              id: 901,
              name,
              expired: false,
              digest: `sha256:${"e".repeat(64)}`,
              workflow_run: { id: 100, head_sha: intent.workflowSha },
            },
          ]
        : [],
    );
    vi.spyOn(github, "download").mockResolvedValue(
      Buffer.from(JSON.stringify(intent)),
    );
    vi.spyOn(github, "request").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 100,
          head_sha: intent.workflowSha,
          path: intent.workflowPath,
          event: "workflow_dispatch",
          status: "in_progress",
          run_attempt: 1,
          repository: { full_name: target.repository },
          head_repository: { full_name: target.repository },
        }),
      ),
    );
    const report = await observeRelease({
      ...input,
      history: () => github.history(target.itemId, "200"),
    });
    expect(report.route).toBe("blocked");
    expect(report.blockers[0].code).toBe("provenance-unavailable");
    expect(report.nextAction).toContain(
      "wait for completion and repeat read-only status",
    );
    expect(report.receipts).toEqual([]);
    expect(input.store.upload).not.toHaveBeenCalled();
    expect(input.store.publish).not.toHaveBeenCalled();
  });
  it.each([
    [
      { submittedItemRevisionStatus: revision("PENDING_REVIEW", "1.18.1") },
      "pending-conflict",
    ],
    [{ warned: true }, "policy-warning"],
    [{ takenDown: true }, "policy-warning"],
    [{ lastAsyncUploadState: "IN_PROGRESS" }, "async-upload"],
    [{ submittedItemRevisionStatus: revision("REJECTED") }, "submitted-state"],
    [
      { publishedItemRevisionStatus: revision("PUBLISHED", "1.19.0") },
      "published-conflict",
    ],
    [
      { submittedItemRevisionStatus: revision("PENDING_REVIEW") },
      "unverified-version",
    ],
  ])("reports a concrete remote blocker", async (extra, code) => {
    const input = setup({ ...remote, ...(extra as object) });
    const report = await observeRelease(input);
    expect(report.blockers[0].code).toBe(code);
    expect(report.nextAction.length).toBeGreaterThan(20);
    expect(input.store.upload).not.toHaveBeenCalled();
    expect(input.store.publish).not.toHaveBeenCalled();
  });
  it.each([
    [
      receipt({ upload: "UNKNOWN", outcome: "UNCERTAIN" }),
      true,
      "uncertain-write",
    ],
    [
      receipt({
        upload: "NOT_ATTEMPTED",
        outcome: "INTENT",
        mutationStarted: false,
      }),
      false,
      "uncertain-write",
    ],
    [
      receipt({
        sourceSha: "e".repeat(40),
        version: "1.18.1",
        package: {
          ...receipt().package,
          zipName: "github-pulls-show-reviewers-1.18.1-chrome.zip",
        },
      }),
      true,
      "outstanding-release",
    ],
  ] as const)(
    "does not turn unresolved receipts into readiness",
    async (r, complete, code) => {
      const input = setup();
      input.history.mockResolvedValue([{ receipt: r, complete }]);
      expect((await observeRelease(input)).blockers[0].code).toBe(code);
      expect(input.store.upload).not.toHaveBeenCalled();
      expect(input.store.publish).not.toHaveBeenCalled();
    },
  );
  it("keeps successful staged uploads on submit-existing routing", async () => {
    const input = setup();
    input.history.mockResolvedValue([{ receipt: receipt(), complete: true }]);
    const report = await observeRelease(input);
    expect(report.route).toBe("staged-listing");
    expect(report.nextAction).toContain("never reupload");
  });
  it("sanitizes API, provenance and artifact failures", async () => {
    for (const fail of ["status", "history", "package"] as const) {
      const input = setup();
      input.history.mockResolvedValue([{ receipt: receipt(), complete: true }]);
      const method =
        fail === "status"
          ? input.store.status
          : fail === "history"
            ? input.history
            : input.verifyPackage;
      method.mockRejectedValue(new Error("Authorization: Bearer secret-key"));
      const report = await observeRelease(input);
      expect(JSON.stringify(report)).not.toMatch(
        /Bearer|secret-key|Authorization/,
      );
      expect(report.blockers[0].code).toBe(
        fail === "status" ? "status-unavailable" : "provenance-unavailable",
      );
      expect(input.store.upload).not.toHaveBeenCalled();
      expect(input.store.publish).not.toHaveBeenCalled();
    }
  });
  it("rechecks a changed remote state after an earlier ready report", async () => {
    const input = setup();
    expect((await observeRelease(input)).route).toBe("ordinary-release");
    input.store.status.mockResolvedValue({
      ...remote,
      submittedItemRevisionStatus: revision("PENDING_REVIEW", "1.18.1"),
    });
    const result = await executeRelease({
      receipt: receipt({
        action: "publish",
        upload: "NOT_ATTEMPTED",
        outcome: "INTENT",
        mutationStarted: false,
      }),
      history: [],
      store: input.store,
      checkpoint: vi.fn(),
    });
    expect(result.receipt.outcome).toBe("STOPPED");
    expect(result.error).toContain("conflicting version");
    expect(input.store.status).toHaveBeenCalledTimes(2);
    expect(input.store.upload).not.toHaveBeenCalled();
    expect(input.store.publish).not.toHaveBeenCalled();
  });
});
