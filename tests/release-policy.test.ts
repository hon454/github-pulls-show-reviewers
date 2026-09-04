import { describe, expect, it, vi } from "vitest";
import { executeRelease } from "../scripts/release/engine.ts";
import {
  inspectStatus,
  resolveAction,
  validateEvidence,
  validateReceipt,
} from "../scripts/release/policy.ts";
import type { Action, Receipt } from "../scripts/release/policy.ts";

const sourceSha = "a".repeat(40);
const itemId = "a".repeat(32);
const now = Date.now();
function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    schemaVersion: 1,
    repository: "hon454/github-pulls-show-reviewers",
    workflowPath: ".github/workflows/release.yml",
    workflowSha: "b".repeat(40),
    runId: "100",
    runAttempt: "1",
    runUrl:
      "https://github.com/hon454/github-pulls-show-reviewers/actions/runs/100",
    sourceSha,
    version: "1.16.0",
    publisherId: "publisher",
    itemId,
    action: "upload-only",
    checked: true,
    timestamp: new Date(now - 60_000).toISOString(),
    package: {
      artifactId: "900",
      artifactName: "chrome-package-100",
      artifactDigest: `sha256:${"c".repeat(64)}`,
      zipName: "github-pulls-show-reviewers-1.16.0-chrome.zip",
      zipSha256: "d".repeat(64),
    },
    upload: "NOT_ATTEMPTED",
    submission: "NOT_ATTEMPTED",
    outcome: "INTENT",
    mutationStarted: false,
    ...overrides,
  };
}
function evidence(overrides = {}) {
  return {
    receiptRunId: "100",
    sourceSha,
    zipSha256: "d".repeat(64),
    itemId,
    version: "1.16.0",
    observedAt: new Date(now - 1000).toISOString(),
    evidenceUrl:
      "https://github.com/hon454/github-pulls-show-reviewers/issues/154#issuecomment-123",
    listingReady: true,
    noInterveningUpload: true,
    draftVersionVerified: true,
    locales: ["en", "ko", "ja", "zh_CN", "zh_TW"],
    ...overrides,
  };
}
function status(kind = "draft", version = "1.16.0") {
  const base = { name: `publishers/publisher/items/${itemId}`, itemId };
  if (kind === "pending")
    return {
      ...base,
      submittedItemRevisionStatus: {
        state: "PENDING_REVIEW",
        distributionChannels: [{ crxVersion: version }],
      },
    };
  return {
    ...base,
    publishedItemRevisionStatus: {
      state: "PUBLISHED",
      distributionChannels: [
        { crxVersion: kind === "published" ? version : "1.15.0" },
      ],
    },
  };
}
function ports(state: unknown = status()) {
  return {
    status: vi.fn(async () => state),
    upload: vi.fn(async () => "SUCCEEDED" as const),
    publish: vi.fn(async () => {}),
  };
}

describe("release event/action matrix", () => {
  it("keeps a new version push-tag automatic", () => {
    expect(resolveAction({ event: "push", ref: "refs/tags/v1.16.0" })).toEqual({
      action: "publish",
      sourceRef: "refs/tags/v1.16.0",
      tag: "v1.16.0",
      createRelease: true,
    });
  });
  for (const ref of ["refs/heads/main", "refs/tags/v1.16.0"]) {
    for (const action of [
      "skip",
      "dry-run",
      "publish",
      "upload-only",
      "submit-existing",
    ] as const) {
      it(`resolves dispatch ${action} on ${ref} explicitly`, () => {
        const staging =
          action === "upload-only" || action === "submit-existing";
        const result = resolveAction({
          event: "workflow_dispatch",
          ref,
          action,
          ...(staging ? { sourceSha, expectedVersion: "1.16.0" } : {}),
          ...(action === "submit-existing" ? { receiptRunId: "100" } : {}),
        });
        expect(result.action).toBe(action);
        expect(result.createRelease).toBe(
          !staging && action !== "dry-run" && ref.startsWith("refs/tags/"),
        );
        if (staging || action === "dry-run") expect(result.tag).toBe("");
      });
    }
  }
  it("defaults tag dispatch to skip and rejects irrelevant combinations", () => {
    expect(
      resolveAction({ event: "workflow_dispatch", ref: "refs/tags/v1.16.0" })
        .action,
    ).toBe("skip");
    for (const input of [
      { event: "push", ref: "refs/heads/main" },
      { event: "pull_request", ref: "refs/tags/v1.16.0" },
      { event: "push", ref: "refs/tags/v1.16.0", action: "skip" },
      { event: "workflow_dispatch", ref: "refs/heads/main", action: "bad" },
      {
        event: "workflow_dispatch",
        ref: "refs/heads/main",
        action: "upload-only",
      },
      {
        event: "workflow_dispatch",
        ref: "refs/heads/main",
        action: "upload-only",
        sourceSha,
        expectedVersion: "1.16.0",
        tag: "v1.16.0",
      },
      {
        event: "workflow_dispatch",
        ref: "refs/heads/main",
        action: "submit-existing",
        sourceSha,
        expectedVersion: "1.16.0",
      },
      {
        event: "workflow_dispatch",
        ref: "refs/heads/main",
        action: "skip",
        sourceSha,
      },
      {
        event: "workflow_dispatch",
        ref: "refs/tags/v1.16.0;echo-bad",
        action: "skip",
      },
    ])
      expect(() => resolveAction(input)).toThrow();
  });
});

describe("receipt and fresh dashboard evidence", () => {
  it("accepts complete provenance and exactly the approved five locales", () => {
    expect(validateReceipt(receipt(), receipt())).toEqual(receipt());
    expect(validateEvidence(evidence(), receipt(), now).listingReady).toBe(
      true,
    );
  });
  it("rejects incomplete, forged, mismatched and secret-bearing receipts", () => {
    for (const candidate of [
      {},
      { ...receipt(), token: "must-not-be-stored" },
      { ...receipt(), checked: false },
      { ...receipt(), sourceSha: "e".repeat(40) },
      { ...receipt(), itemId: "b".repeat(32) },
      {
        ...receipt(),
        runUrl: "https://github.com/other/repo/actions/runs/100",
      },
      {
        ...receipt(),
        package: { ...receipt().package, artifactName: "forged" },
      },
      {
        ...receipt(),
        package: { ...receipt().package, zipSha256: "not-a-hash" },
      },
      {
        ...receipt(),
        package: {
          ...receipt().package,
          zipName: "github-pulls-show-reviewers-1.15.0-chrome.zip",
        },
      },
    ])
      expect(() => validateReceipt(candidate, receipt())).toThrow();
  });
  it("rejects stale, unbound, wrong-locale and missing dashboard evidence", () => {
    for (const candidate of [
      undefined,
      evidence({ observedAt: new Date(now - 3_600_001).toISOString() }),
      evidence({ observedAt: new Date(now + 1000).toISOString() }),
      evidence({ receiptRunId: "101" }),
      evidence({ listingReady: false }),
      evidence({ draftVersionVerified: false }),
      evidence({ locales: ["en", "ko", "ja", "fr", "de"] }),
      evidence({ locales: ["en", "ko", "ja", "zh_CN", "zh_CN"] }),
      evidence({
        evidenceUrl:
          "https://github.com/hon454/github-pulls-show-reviewers/issues/154?token=secret",
      }),
    ])
      expect(() => validateEvidence(candidate, receipt(), now)).toThrow();
  });
});

describe("CWS state transitions and actual mutation counts", () => {
  for (const action of ["upload-only", "publish"] as Action[]) {
    it(`${action} performs only its authorized calls`, async () => {
      const store = ports();
      const checkpoint = vi.fn(async () => {});
      const result = await executeRelease({
        receipt: receipt({ action }),
        history: [],
        store,
        checkpoint,
      });
      expect(result.error).toBeUndefined();
      expect(store.upload).toHaveBeenCalledTimes(1);
      expect(store.publish).toHaveBeenCalledTimes(action === "publish" ? 1 : 0);
      expect(checkpoint.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(result.receipt.upload).toBe("SUCCEEDED");
    });
  }
  it("submit-existing publishes exactly once and never uploads", async () => {
    const prior = receipt({
      upload: "SUCCEEDED",
      outcome: "UPLOADED",
      mutationStarted: true,
    });
    const store = ports();
    const result = await executeRelease({
      receipt: receipt({ action: "submit-existing" }),
      prior,
      history: [{ receipt: prior, complete: true }],
      evidence: evidence(),
      store,
      checkpoint: async () => {},
    });
    expect(result.error).toBeUndefined();
    expect(store.upload).not.toHaveBeenCalled();
    expect(store.publish).toHaveBeenCalledTimes(1);
    expect(result.receipt.outcome).toBe("SUBMITTED");
  });
  for (const kind of ["pending", "published"]) {
    for (const action of [
      "publish",
      "submit-existing",
      "upload-only",
    ] as Action[]) {
      it(`${action} observes already ${kind} without any mutation`, async () => {
        const prior = receipt({ upload: "SUCCEEDED", submission: "UNKNOWN" });
        const store = ports(status(kind));
        const result = await executeRelease({
          receipt: receipt({ action }),
          prior,
          history: [{ receipt: prior, complete: true }],
          store,
          checkpoint: async () => {},
        });
        expect(result.error).toBeUndefined();
        expect(store.upload).not.toHaveBeenCalled();
        expect(store.publish).not.toHaveBeenCalled();
        expect(result.receipt.outcome).toBe(
          kind === "pending" ? "ALREADY_PENDING" : "ALREADY_PUBLISHED",
        );
      });
    }
  }
  it("does not trust version equality without source/package provenance", async () => {
    const store = ports(status("published"));
    const result = await executeRelease({
      receipt: receipt({ action: "publish" }),
      history: [],
      store,
      checkpoint: async () => {},
    });
    expect(result.error).toContain("Version equality");
    expect(store.upload).not.toHaveBeenCalled();
    expect(store.publish).not.toHaveBeenCalled();
  });
  it("rejects a mismatched source or zip before remote access", async () => {
    for (const prior of [
      receipt({ sourceSha: "e".repeat(40) }),
      receipt({ package: { ...receipt().package, zipSha256: "e".repeat(64) } }),
    ]) {
      const store = ports();
      const result = await executeRelease({
        receipt: receipt({ action: "submit-existing" }),
        prior,
        history: [],
        evidence: evidence(),
        store,
        checkpoint: async () => {},
      });
      expect(result.error).toContain("mismatch");
      expect(store.status).not.toHaveBeenCalled();
      expect(store.upload).not.toHaveBeenCalled();
      expect(store.publish).not.toHaveBeenCalled();
    }
  });
  it("blocks a different source's unfinished or uncertain intent for the same item", async () => {
    for (const previous of [
      receipt({ sourceSha: "e".repeat(40) }),
      receipt({
        sourceSha: "e".repeat(40),
        mutationStarted: true,
        upload: "UNKNOWN",
        outcome: "UNCERTAIN",
      }),
    ]) {
      const store = ports();
      const result = await executeRelease({
        receipt: receipt(),
        history: [
          { receipt: previous, complete: previous.outcome !== "INTENT" },
        ],
        store,
        checkpoint: async () => {},
      });
      expect(result.error).toContain("Another release");
      expect(store.upload).not.toHaveBeenCalled();
      expect(store.publish).not.toHaveBeenCalled();
    }
  });
  it("blocks reupload after a known draft and resubmission after an uncertain request", async () => {
    for (const prior of [
      receipt({ upload: "SUCCEEDED" }),
      receipt({ upload: "SUCCEEDED", submission: "UNKNOWN" }),
    ]) {
      const store = ports();
      const result = await executeRelease({
        receipt: receipt({ action: "publish" }),
        prior,
        history: [{ receipt: prior, complete: true }],
        store,
        checkpoint: async () => {},
      });
      expect(result.error).toBeDefined();
      expect(store.upload).not.toHaveBeenCalled();
      expect(store.publish).not.toHaveBeenCalled();
    }
  });
  it("records an in-progress upload without retrying or publishing", async () => {
    const store = {
      ...ports(),
      upload: vi.fn(async () => "IN_PROGRESS" as const),
    };
    const result = await executeRelease({
      receipt: receipt({ action: "publish" }),
      history: [],
      store,
      checkpoint: async () => {},
    });
    expect(result.receipt.upload).toBe("IN_PROGRESS");
    expect(result.receipt.outcome).toBe("UNCERTAIN");
    expect(store.upload).toHaveBeenCalledTimes(1);
    expect(store.publish).not.toHaveBeenCalled();
  });
  it("recovers a confirmed async upload only through fresh explicit evidence and zero uploads", async () => {
    const prior = receipt({
      upload: "IN_PROGRESS",
      outcome: "UNCERTAIN",
      mutationStarted: true,
    });
    const store = ports({ ...status(), lastAsyncUploadState: "SUCCEEDED" });
    const result = await executeRelease({
      receipt: receipt({ action: "submit-existing" }),
      prior,
      history: [{ receipt: prior, complete: true }],
      evidence: evidence({ asyncUploadConfirmed: true }),
      store,
      checkpoint: async () => {},
    });
    expect(result.error).toBeUndefined();
    expect(store.upload).not.toHaveBeenCalled();
    expect(store.publish).toHaveBeenCalledTimes(1);
  });
  it("never treats a timeout as a confirmed failure safe to retry", async () => {
    const store = {
      ...ports(),
      publish: vi.fn(async () => {
        throw new Error("timeout containing a secret");
      }),
    };
    const result = await executeRelease({
      receipt: receipt({ action: "publish" }),
      history: [],
      store,
      checkpoint: async () => {},
    });
    expect(result.receipt.submission).toBe("UNKNOWN");
    expect(result.receipt.outcome).toBe("UNCERTAIN");
    expect(result.error).not.toContain("secret");
    expect(store.publish).toHaveBeenCalledTimes(1);
  });
  it("rejects conflicting, rejected, cancelled, staged, malformed and async states", () => {
    for (const raw of [
      {},
      status("pending", "1.17.0"),
      status("published", "1.17.0"),
      { ...status(), lastAsyncUploadState: "IN_PROGRESS" },
      { ...status(), takenDown: true },
      ...["REJECTED", "CANCELLED", "STAGED"].map((state) => ({
        ...status(),
        submittedItemRevisionStatus: {
          state,
          distributionChannels: [{ crxVersion: "1.16.0" }],
        },
      })),
    ])
      expect(() => inspectStatus(raw, receipt(), "1.16.0")).toThrow();
  });
});
