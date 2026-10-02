import { describe, expect, it, vi } from "vitest";
import { GitHubProvenance } from "../scripts/release/provenance.ts";
import { executeRelease } from "../scripts/release/engine.ts";
import { selectPriorReceipt } from "../scripts/release/readiness.ts";
import type { Receipt } from "../scripts/release/policy.ts";

const repository = "hon454/github-pulls-show-reviewers";
const receipt: Receipt = {
  schemaVersion: 1,
  repository,
  workflowPath: ".github/workflows/release.yml",
  workflowSha: "a".repeat(40),
  runId: "100",
  runAttempt: "1",
  runUrl: `https://github.com/${repository}/actions/runs/100`,
  sourceSha: "b".repeat(40),
  version: "1.16.0",
  publisherId: "publisher",
  itemId: "a".repeat(32),
  action: "upload-only",
  checked: true,
  timestamp: "2026-09-04T00:00:00Z",
  package: {
    artifactId: "10",
    artifactName: "chrome-package-100",
    artifactDigest: `sha256:${"c".repeat(64)}`,
    zipName: "github-pulls-show-reviewers-1.16.0-chrome.zip",
    zipSha256: "d".repeat(64),
  },
  upload: "NOT_ATTEMPTED",
  submission: "NOT_ATTEMPTED",
  outcome: "INTENT",
  mutationStarted: false,
};
const artifact = {
  id: 11,
  name: `cws-intent-${receipt.itemId}`,
  expired: false,
  digest: `sha256:${"c".repeat(64)}`,
  workflow_run: { id: 100, head_sha: receipt.workflowSha },
};
const run = {
  id: 100,
  head_sha: receipt.workflowSha,
  path: receipt.workflowPath,
  event: "workflow_dispatch",
  status: "completed",
  run_attempt: 1,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
};
const steps = [
  "Production preflight",
  "Release verification",
  "Checked package",
  "Record checked package",
].map((name) => ({ name, conclusion: "success" }));
const response = (data: unknown) => new Response(JSON.stringify(data));

describe("durable receipt provenance", () => {
  it("requires trusted workflow/source commits and all successful checked build steps", async () => {
    const trust = vi.fn();
    const github = new GitHubProvenance(repository, "fake-token", trust);
    vi.spyOn(github, "request")
      .mockResolvedValueOnce(response(run))
      .mockResolvedValueOnce(response({ jobs: [{ name: "package", steps }] }));
    await github.verifyRun(receipt, artifact);
    expect(trust.mock.calls).toEqual([
      [receipt.workflowSha],
      [receipt.sourceSha],
    ]);
  });
  it("rejects forked, wrong-workflow, incomplete, rerun and mismatched runs", async () => {
    for (const candidate of [
      { ...run, head_repository: { full_name: "attacker/repository" } },
      { ...run, path: ".github/workflows/fake.yml" },
      { ...run, status: "in_progress" },
      { ...run, run_attempt: 2 },
      { ...run, head_sha: "e".repeat(40) },
    ]) {
      const github = new GitHubProvenance(repository, "fake-token", vi.fn());
      vi.spyOn(github, "request").mockResolvedValue(response(candidate));
      await expect(github.verifyRun(receipt, artifact)).rejects.toThrow();
    }
  });
  it("rejects a receipt when any required build gate was skipped or failed", async () => {
    for (const conclusion of ["skipped", "failure", null]) {
      const github = new GitHubProvenance(repository, "fake-token", vi.fn());
      vi.spyOn(github, "request")
        .mockResolvedValueOnce(response(run))
        .mockResolvedValueOnce(
          response({
            jobs: [
              {
                name: "package",
                steps: steps.map((step) =>
                  step.name === "Checked package"
                    ? { ...step, conclusion }
                    : step,
                ),
              },
            ],
          }),
        );
      await expect(github.verifyRun(receipt, artifact)).rejects.toThrow(
        "Checked package",
      );
    }
  });
  it("discovers item-wide intents even when another source has no result receipt", async () => {
    const github = new GitHubProvenance(repository, "fake-token", vi.fn());
    vi.spyOn(github, "artifacts").mockImplementation(async (name) =>
      name.startsWith("cws-intent") ? [artifact] : [],
    );
    vi.spyOn(github, "download").mockResolvedValue(
      Buffer.from(JSON.stringify(receipt)),
    );
    vi.spyOn(github, "verifyRun").mockResolvedValue();
    const history = await github.history(receipt.itemId, "200");
    expect(history).toEqual([{ receipt, complete: false }]);
    expect(github.artifacts).toHaveBeenCalledWith(
      `cws-intent-${receipt.itemId}`,
    );
  });
  it("blocks upload-only when a result remains without its durable intent", async () => {
    const github = new GitHubProvenance(repository, "fake-token", vi.fn());
    vi.spyOn(github, "artifacts").mockImplementation(async (name) =>
      name.startsWith("cws-result") ? [artifact] : [],
    );
    const download = vi.spyOn(github, "download");
    const store = {
      status: vi.fn(async () => ({
        name: `publishers/publisher/items/${receipt.itemId}`,
        itemId: receipt.itemId,
        publishedItemRevisionStatus: {
          state: "PUBLISHED",
          distributionChannels: [{ crxVersion: "1.15.0" }],
        },
      })),
      upload: vi.fn(async () => "SUCCEEDED" as const),
      publish: vi.fn(async () => {}),
    };
    await expect(
      github.history(receipt.itemId, "200").then((history) =>
        executeRelease({
          receipt: { ...receipt, sourceSha: "e".repeat(40) },
          history,
          store,
          checkpoint: async () => {},
        }),
      ),
    ).rejects.toThrow("Missing or ambiguous durable intent");
    expect(download).not.toHaveBeenCalled();
    expect(store.status).not.toHaveBeenCalled();
    expect(store.upload).not.toHaveBeenCalled();
    expect(store.publish).not.toHaveBeenCalled();
  });
  it("rejects an orphan result even when another run has a complete pair", async () => {
    const github = new GitHubProvenance(repository, "fake-token", vi.fn());
    const orphan = {
      ...artifact,
      id: 12,
      workflow_run: { ...artifact.workflow_run, id: 101 },
    };
    vi.spyOn(github, "artifacts").mockImplementation(async (name) =>
      name.startsWith("cws-result") ? [artifact, orphan] : [artifact],
    );
    const download = vi.spyOn(github, "download");
    await expect(github.history(receipt.itemId, "200")).rejects.toThrow(
      "Missing or ambiguous durable intent",
    );
    expect(download).not.toHaveBeenCalled();
  });
  it("rejects duplicate intents for the same run instead of trusting one", async () => {
    const github = new GitHubProvenance(repository, "fake-token", vi.fn());
    vi.spyOn(github, "artifacts").mockImplementation(async (name) =>
      name.startsWith("cws-intent") ? [artifact, { ...artifact, id: 12 }] : [],
    );
    await expect(github.history(receipt.itemId, "200")).rejects.toThrow(
      "Missing or ambiguous durable intent",
    );
  });
  it("rejects altered result provenance and mismatched checked package artifacts", async () => {
    const github = new GitHubProvenance(repository, "fake-token", vi.fn());
    vi.spyOn(github, "artifacts").mockResolvedValue([artifact]);
    vi.spyOn(github, "download")
      .mockResolvedValueOnce(Buffer.from(JSON.stringify(receipt)))
      .mockResolvedValueOnce(
        Buffer.from(
          JSON.stringify({
            ...receipt,
            upload: "SUCCEEDED",
            sourceSha: "e".repeat(40),
          }),
        ),
      );
    vi.spyOn(github, "verifyRun").mockResolvedValue();
    await expect(github.history(receipt.itemId, "200")).rejects.toThrow(
      "sourceSha mismatch",
    );
    vi.spyOn(github, "request").mockResolvedValue(
      response({
        ...artifact,
        id: 10,
        name: receipt.package.artifactName,
        workflow_run: { id: 999, head_sha: receipt.workflowSha },
      }),
    );
    await expect(github.restorePackage(receipt)).rejects.toThrow(
      "provenance mismatch",
    );
  });
  it("drops a fully expired completed pair but keeps readable history", async () => {
    const github = new GitHubProvenance(repository, "fake-token", vi.fn());
    const old = (id: number, name: string) => ({
      ...artifact,
      id,
      name,
      expired: true,
      workflow_run: { ...artifact.workflow_run, id: 90 },
    });
    vi.spyOn(github, "artifacts").mockImplementation(async (name) =>
      name.startsWith("cws-intent") ? [old(1, name), artifact] : [old(2, name)],
    );
    const download = vi
      .spyOn(github, "download")
      .mockResolvedValue(Buffer.from(JSON.stringify(receipt)));
    vi.spyOn(github, "verifyRun").mockResolvedValue();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const history = await github.history(receipt.itemId, "200");
    expect(history).toEqual([{ receipt, complete: false }]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(artifact, "intent.json");
  });
  it("fails closed for an expired intent without a result or a partly expired pair", async () => {
    const expiredIntent = { ...artifact, expired: true };
    const result = { ...artifact, id: 12, name: "cws-result" };
    for (const [intents, results] of [
      [[expiredIntent], []],
      [[expiredIntent], [result]],
      [[artifact], [{ ...result, expired: true }]],
    ]) {
      const github = new GitHubProvenance(repository, "fake-token", vi.fn());
      vi.spyOn(github, "artifacts").mockImplementation(async (name) =>
        name.startsWith("cws-intent") ? intents : results,
      );
      const download = vi.spyOn(github, "download");
      await expect(github.history(receipt.itemId, "200")).rejects.toThrow(
        "incomplete or partly retained receipt run",
      );
      expect(download).not.toHaveBeenCalled();
    }
  });
  it("does not let an aged-out upload receipt satisfy a later submit-existing", async () => {
    const github = new GitHubProvenance(repository, "fake-token", vi.fn());
    vi.spyOn(github, "artifacts").mockResolvedValue([
      { ...artifact, expired: true },
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const history = await github.history(receipt.itemId, "200");
    expect(history).toEqual([]);
    expect(() => selectPriorReceipt(receipt, history, receipt.runId)).toThrow(
      "Missing or ambiguous original upload receipt",
    );
  });
  it("stops before reading expired or digest-less artifacts", async () => {
    const github = new GitHubProvenance(repository, "fake-token", vi.fn());
    const request = vi.spyOn(github, "request");
    await expect(
      github.download({ ...artifact, expired: true }, "intent.json"),
    ).rejects.toThrow("expired");
    await expect(
      github.download({ ...artifact, digest: "" }, "intent.json"),
    ).rejects.toThrow("digest");
    expect(request).not.toHaveBeenCalled();
  });
});
