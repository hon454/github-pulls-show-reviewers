import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeRelease } from "../scripts/release/engine.ts";
import {
  resolveAction,
  validateEvidence,
  validateReceipt,
} from "../scripts/release/policy.ts";
import type { Receipt, StoreStatus } from "../scripts/release/policy.ts";

// This exercises the documented handoff with real engine/policy contracts.
// The in-memory dashboard is only a walkthrough, not live UI validation.
const runbook = readFileSync("docs/chrome-web-store-agent-runbook.md", "utf8");
const example = JSON.parse(runbook.match(/```json\n([\s\S]*?)\n```/)![1]!);
const observed = Date.parse(example.observedAt);
const locales = ["en", "ko", "ja", "zh_CN", "zh_TW"];
const names = [
  "01-pr-list-before-after.png",
  "02-pr-list-avatar-state-showcase.png",
  "03-options-repository-check.png",
];
const manifest = JSON.parse(
  readFileSync("docs/chrome-web-store-assets/capture-manifest.json", "utf8"),
);
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
type Listing = { text: string; images: string[] };
const materials = new Map<string, Listing>(
  locales.map((locale) => {
    const copyPath = `docs/chrome-web-store-locales/${locale}.md`;
    const copy = readFileSync(copyPath, "utf8");
    expect(hash(copy)).toBe(manifest.sources[copyPath]);
    const text = copy
      .split("<!-- description:start -->")[1]!
      .split("<!-- description:end -->")[0]!
      .trim();
    const images = names.map((name) => {
      const file = `docs/chrome-web-store-assets/${locale === "en" ? "" : `${locale}/`}${name}`;
      expect(hash(readFileSync(file))).toBe(manifest.images[file]);
      return file;
    });
    return [locale, { text, images }];
  }),
);

function intent(
  runId = example.receiptRunId,
  action: Receipt["action"] = "upload-only",
): Receipt {
  return {
    schemaVersion: 1,
    repository: "hon454/github-pulls-show-reviewers",
    workflowPath: ".github/workflows/release.yml",
    workflowSha: "c".repeat(40),
    runId,
    runAttempt: "1",
    runUrl: `https://github.com/hon454/github-pulls-show-reviewers/actions/runs/${runId}`,
    sourceSha: example.sourceSha,
    version: example.version,
    publisherId: "fixture-publisher",
    itemId: example.itemId,
    action,
    checked: true,
    timestamp: new Date(observed - 60_000).toISOString(),
    package: {
      artifactId: "900",
      artifactName: `chrome-package-${runId}`,
      artifactDigest: `sha256:${"d".repeat(64)}`,
      zipName: `github-pulls-show-reviewers-${example.version}-chrome.zip`,
      zipSha256: example.zipSha256,
    },
    upload: "NOT_ATTEMPTED",
    submission: "NOT_ATTEMPTED",
    outcome: "INTENT",
    mutationStarted: false,
  };
}

function ports(uploadState: "SUCCEEDED" | "IN_PROGRESS" = "SUCCEEDED") {
  let current: StoreStatus = {
    name: `publishers/fixture-publisher/items/${example.itemId}`,
    itemId: example.itemId,
    lastAsyncUploadState: "SUCCEEDED",
  };
  return {
    status: vi.fn(async () => structuredClone(current)),
    upload: vi.fn(async () => uploadState),
    publish: vi.fn(async () => {}),
    observe(update: Partial<StoreStatus>) {
      current = { ...current, ...update };
    },
  };
}

// Reopen reads independent persisted state, never an editor buffer/save toast.
class DashboardFixture {
  saved = new Map<string, Listing>();
  imageAdds: string[] = [];
  reopened = new Map<string, Listing>();
  save(locale: string, loseResponse = false, knownPrevious: string[] = []) {
    const target = materials.get(locale)!;
    const before = this.saved.get(locale) ?? { text: "", images: [] };
    if (
      !before.images.every(
        (image) =>
          target.images.includes(image) || knownPrevious.includes(image),
      )
    )
      throw new Error(
        "Unexpected existing image inventory; inspect before replacement",
      );
    const missing = target.images.filter(
      (image) => !before.images.includes(image),
    );
    this.imageAdds.push(...missing);
    this.saved.set(locale, {
      text: target.text,
      images: [...target.images],
    });
    this.reopened.delete(locale);
    if (loseResponse) throw new Error("Save response lost after persistence");
  }
  navigateAwayAndBack(locale: string) {
    const persisted = structuredClone(this.saved.get(locale));
    expect(persisted).toEqual(materials.get(locale));
    this.reopened.set(locale, persisted!);
  }
  ready() {
    for (const locale of locales)
      expect(this.reopened.get(locale)).toEqual(materials.get(locale));
    return structuredClone(example);
  }
}

afterEach(() => vi.useRealTimers());

describe("canonical agent runbook mock walkthrough", () => {
  it("uses the documented JSON through upload, five persisted listings, submit and same-source tag reuse", async () => {
    vi.useFakeTimers().setSystemTime(observed);
    const store = ports();
    const checkpoints: Receipt[] = [];
    const checkpoint = async (receipt: Receipt) => {
      checkpoints.push(structuredClone(receipt));
    };
    const upload = await executeRelease({
      receipt: intent(),
      history: [],
      store,
      checkpoint,
    });
    expect(upload.error).toBeUndefined();
    expect(upload.receipt).toMatchObject({
      upload: "SUCCEEDED",
      submission: "NOT_ATTEMPTED",
      outcome: "UPLOADED",
    });
    expect(checkpoints[0]).toMatchObject({
      upload: "UNKNOWN",
      mutationStarted: true,
    });
    validateReceipt(upload.receipt, intent());
    const dashboard = new DashboardFixture();
    for (const locale of locales) {
      dashboard.save(locale);
      dashboard.navigateAwayAndBack(locale);
    }
    expect(dashboard.imageAdds).toHaveLength(15);
    expect(new Set(dashboard.imageAdds).size).toBe(15);
    const evidence = validateEvidence(dashboard.ready(), upload.receipt);
    const history = [{ receipt: upload.receipt, complete: true }];
    const submission = await executeRelease({
      receipt: {
        ...intent("200", "submit-existing"),
        priorReceiptRunId: upload.receipt.runId,
      },
      prior: upload.receipt,
      history,
      evidence,
      store,
      checkpoint,
    });
    expect(submission.error).toBeUndefined();
    expect(submission.receipt.outcome).toBe("SUBMITTED");
    const tag = resolveAction({
      event: "push",
      ref: `refs/tags/v${example.version}`,
    });
    expect(tag.createRelease).toBe(true);
    for (const state of ["PENDING_REVIEW", "PUBLISHED"] as const) {
      const revision = {
        state,
        distributionChannels: [{ crxVersion: example.version }],
      };
      store.observe(
        state === "PENDING_REVIEW"
          ? { submittedItemRevisionStatus: revision }
          : {
              submittedItemRevisionStatus: undefined,
              publishedItemRevisionStatus: revision,
            },
      );
      const tagged = await executeRelease({
        receipt: intent(state === "PENDING_REVIEW" ? "300" : "400", tag.action),
        prior: upload.receipt,
        history,
        store,
        checkpoint,
      });
      expect(tagged.error).toBeUndefined();
      expect(tagged.receipt.outcome).toBe(
        state === "PENDING_REVIEW" ? "ALREADY_PENDING" : "ALREADY_PUBLISHED",
      );
    }
    expect(store.upload).toHaveBeenCalledTimes(1);
    expect(store.publish).toHaveBeenCalledTimes(1);
  });

  it("resumes a lost save response without duplicate images and stays ready without submit authority", () => {
    const dashboard = new DashboardFixture();
    for (const locale of ["en", "ko"]) {
      dashboard.save(locale);
      dashboard.navigateAwayAndBack(locale);
    }
    expect(() => dashboard.save("ja", true)).toThrow("response lost");
    expect(() => dashboard.ready()).toThrow();
    // Fresh operator reopens persisted state before deciding whether to save.
    for (const locale of ["en", "ko", "ja"])
      dashboard.navigateAwayAndBack(locale);
    dashboard.save("ja"); // Even an unnecessary repeat adds zero images.
    dashboard.navigateAwayAndBack("ja");
    for (const locale of ["zh_CN", "zh_TW"]) {
      dashboard.save(locale);
      dashboard.navigateAwayAndBack(locale);
    }
    expect(dashboard.imageAdds).toHaveLength(15);
    expect(dashboard.ready().locales).toEqual(locales);
    // Permission is an operator gate, not a field enforced by the release API.
    // End the walkthrough here: do not dispatch submit-existing without scope.
  });

  it.each(["text", "images"] as const)(
    "refuses readiness when a successful save loses persisted %s",
    (field) => {
      const dashboard = new DashboardFixture();
      dashboard.save("ko");
      const stored = dashboard.saved.get("ko")!;
      if (field === "text") stored.text = stored.text.slice(0, -10);
      else stored.images.pop();
      expect(() => dashboard.navigateAwayAndBack("ko")).toThrow();
      expect(() => dashboard.ready()).toThrow();
    },
  );

  it("replaces identified previous-release images and resumes a mixed inventory without duplicating targets", () => {
    const dashboard = new DashboardFixture();
    const previous = [
      "previous-release-01.png",
      "previous-release-02.png",
      "previous-release-03.png",
    ];
    const before = { text: "previous description", images: previous };
    const beforeEvidence = structuredClone(before);
    dashboard.saved.set("en", before);
    dashboard.save("en", false, previous);
    dashboard.navigateAwayAndBack("en");
    expect(dashboard.imageAdds).toEqual(materials.get("en")!.images);
    expect(beforeEvidence).toEqual(before);
    // An interrupted replacement already persisted target 01 in another locale.
    const target = materials.get("ko")!;
    dashboard.saved.set("ko", {
      text: "previous",
      images: [target.images[0]!, ...previous.slice(1)],
    });
    dashboard.save("ko", false, previous);
    dashboard.navigateAwayAndBack("ko");
    expect(dashboard.imageAdds.slice(3)).toEqual(target.images.slice(1));
  });

  it("stops on unknown images instead of deleting or appending", () => {
    const dashboard = new DashboardFixture();
    dashboard.saved.set("ja", { text: "before", images: ["unknown.png"] });
    expect(() => dashboard.save("ja")).toThrow("Unexpected existing image");
    expect(dashboard.saved.get("ja")).toEqual({
      text: "before",
      images: ["unknown.png"],
    });
    expect(dashboard.imageAdds).toEqual([]);
  });

  it("requires a fresh reobservation after interruption exceeds the evidence hour", () => {
    expect(() =>
      validateEvidence(example, intent(), observed + 3_600_001),
    ).toThrow("one hour");
    expect(() =>
      validateEvidence(
        { ...example, locales: ["en", "ko", "ja", "zh_CN", "zh_CN"] },
        intent(),
        observed,
      ),
    ).toThrow("exactly");
  });

  it("recovers known asynchronous upload with original receipt and explicit evidence, never a second upload", async () => {
    vi.useFakeTimers().setSystemTime(observed);
    const store = ports("IN_PROGRESS");
    const checkpoint = vi.fn(async () => {});
    const upload = await executeRelease({
      receipt: intent(),
      history: [],
      store,
      checkpoint,
    });
    expect(upload.receipt).toMatchObject({
      upload: "IN_PROGRESS",
      outcome: "UNCERTAIN",
    });
    const args = {
      receipt: intent("200", "submit-existing"),
      prior: upload.receipt,
      history: [{ receipt: upload.receipt, complete: true }],
      store,
      checkpoint,
    };
    const early = await executeRelease({ ...args, evidence: example });
    expect(early.receipt.outcome).toBe("STOPPED");
    const recovered = await executeRelease({
      ...args,
      evidence: { ...example, asyncUploadConfirmed: true },
    });
    expect(recovered.receipt.outcome).toBe("SUBMITTED");
    expect(store.upload).toHaveBeenCalledTimes(1);
    expect(store.publish).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown-upload", "rejected"])(
    "stops the %s walkthrough without another mutation",
    async (scenario) => {
      vi.useFakeTimers().setSystemTime(observed);
      const store = ports();
      const checkpoint = vi.fn(async () => {});
      if (scenario === "unknown-upload")
        store.upload.mockRejectedValueOnce(new Error("response lost"));
      const upload = await executeRelease({
        receipt: intent(),
        history: [],
        store,
        checkpoint,
      });
      if (scenario === "rejected")
        store.observe({
          submittedItemRevisionStatus: {
            state: "REJECTED",
            distributionChannels: [{ crxVersion: example.version }],
          },
        });
      const resumed = await executeRelease({
        receipt: intent("200", "submit-existing"),
        prior: upload.receipt,
        history: [{ receipt: upload.receipt, complete: true }],
        evidence: { ...example, asyncUploadConfirmed: true },
        store,
        checkpoint,
      });
      expect(resumed.receipt.outcome).toBe("STOPPED");
      expect(store.upload).toHaveBeenCalledTimes(1);
      expect(store.publish).not.toHaveBeenCalled();
    },
  );
});
