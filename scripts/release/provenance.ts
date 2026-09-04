import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  parse,
  receiptSchema,
  ReleaseError,
  requireCondition,
  validateReceipt,
} from "./policy.ts";
import type { Receipt } from "./policy.ts";

const artifactSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  expired: z.boolean(),
  digest: z.string(),
  workflow_run: z.object({
    id: z.number().int().positive(),
    head_sha: z.string(),
  }),
});
type Artifact = z.infer<typeof artifactSchema>;
export type HistoryEntry = { receipt: Receipt; complete: boolean };
export const sha256 = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");

export class GitHubProvenance {
  readonly repository: string;
  readonly token: string;
  readonly trustCommit: (sha: string) => void;
  constructor(
    repository: string,
    token: string,
    trustCommit: (sha: string) => void,
  ) {
    this.repository = repository;
    this.token = token;
    this.trustCommit = trustCommit;
  }
  async request(endpoint: string): Promise<Response> {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${this.repository}/${endpoint}`,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(60_000),
        },
      );
      requireCondition(
        response.ok,
        `GitHub provenance lookup failed (HTTP ${response.status}).`,
      );
      return response;
    } catch (error) {
      if (error instanceof ReleaseError) throw error;
      throw new ReleaseError(
        "GitHub provenance lookup is unavailable; no CWS mutation is safe.",
      );
    }
  }
  async artifacts(name: string) {
    const artifacts: Artifact[] = [];
    for (let page = 1; page <= 20; page++) {
      const raw: unknown = await (
        await this.request(
          `actions/artifacts?name=${encodeURIComponent(name)}&per_page=100&page=${page}`,
        )
      ).json();
      const result = parse(
        z.object({ artifacts: z.array(artifactSchema) }),
        raw,
        "GitHub artifact list",
      );
      artifacts.push(...result.artifacts);
      if (result.artifacts.length < 100) return artifacts;
    }
    throw new ReleaseError(
      "Receipt history is too large to inspect completely; explicit archival/recovery is required.",
    );
  }
  async download(artifact: Artifact, entry: string): Promise<Buffer> {
    requireCondition(
      !artifact.expired,
      "A required provenance artifact expired; stop for explicit recovery.",
    );
    requireCondition(
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest),
      "Artifact has no trusted SHA-256 digest.",
    );
    const response = await this.request(`actions/artifacts/${artifact.id}/zip`);
    const bytes = Buffer.from(await response.arrayBuffer());
    requireCondition(
      bytes.length <= 30 * 1024 * 1024,
      "Provenance artifact is unexpectedly large.",
    );
    requireCondition(
      `sha256:${sha256(bytes)}` === artifact.digest,
      "Downloaded artifact digest mismatch.",
    );
    await mkdir(".release/downloads", { recursive: true });
    const file = `.release/downloads/${artifact.id}.zip`;
    await writeFile(file, bytes);
    try {
      const entries = execFileSync("unzip", ["-Z1", file], {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
      })
        .trim()
        .split("\n");
      requireCondition(
        entries.length === 1 && entries[0] === entry,
        "Artifact must contain exactly the expected file.",
      );
      return execFileSync("unzip", ["-p", file, entry], {
        maxBuffer: 30 * 1024 * 1024,
      });
    } catch (error) {
      if (error instanceof ReleaseError) throw error;
      throw new ReleaseError("Provenance artifact could not be read safely.");
    }
  }
  async verifyRun(receipt: Receipt, artifact: Artifact) {
    requireCondition(
      artifact.workflow_run.id.toString() === receipt.runId &&
        artifact.workflow_run.head_sha === receipt.workflowSha,
      "Receipt artifact belongs to a different workflow run.",
    );
    const run = parse(
      z.object({
        id: z.number(),
        head_sha: z.string(),
        path: z.string(),
        event: z.string(),
        status: z.string(),
        run_attempt: z.number(),
        repository: z.object({ full_name: z.string() }),
        head_repository: z.object({ full_name: z.string() }),
      }),
      await (await this.request(`actions/runs/${receipt.runId}`)).json(),
      "receipt workflow run",
    );
    requireCondition(
      run.id.toString() === receipt.runId &&
        run.head_sha === receipt.workflowSha &&
        run.repository.full_name === this.repository &&
        run.head_repository.full_name === this.repository &&
        run.path === receipt.workflowPath &&
        ["push", "workflow_dispatch"].includes(run.event) &&
        run.status === "completed" &&
        run.run_attempt === 1,
      "Receipt was not produced by a completed trusted release workflow.",
    );
    this.trustCommit(receipt.workflowSha);
    this.trustCommit(receipt.sourceSha);
    const jobs = parse(
      z.object({
        jobs: z.array(
          z.object({
            name: z.string(),
            steps: z
              .array(
                z.object({
                  name: z.string(),
                  conclusion: z.string().nullable(),
                }),
              )
              .optional(),
          }),
        ),
      }),
      await (
        await this.request(
          `actions/runs/${receipt.runId}/attempts/1/jobs?per_page=100`,
        )
      ).json(),
      "receipt build gates",
    );
    const job = jobs.jobs.find((j) => j.name === "package");
    for (const name of [
      "Production preflight",
      "Release verification",
      "Checked package",
      "Record checked package",
    ])
      requireCondition(
        job?.steps?.some(
          (step) => step.name === name && step.conclusion === "success",
        ),
        `Receipt lacks successful ${name} evidence.`,
      );
  }
  async history(itemId: string, currentRunId: string): Promise<HistoryEntry[]> {
    const [intents, results] = await Promise.all([
      this.artifacts(`cws-intent-${itemId}`),
      this.artifacts(`cws-result-${itemId}`),
    ]);
    const runs = new Map<
      string,
      { intents: Artifact[]; results: Artifact[] }
    >();
    for (const [kind, artifacts] of [
      ["intents", intents],
      ["results", results],
    ] as const) {
      for (const artifact of artifacts) {
        const runId = artifact.workflow_run.id.toString();
        if (runId === currentRunId) continue;
        const pair = runs.get(runId) ?? { intents: [], results: [] };
        pair[kind].push(artifact);
        runs.set(runId, pair);
      }
    }
    // Validate both directions before accepting any history. A result whose
    // intent was deleted is evidence of an operation, never an empty history.
    for (const pair of runs.values()) {
      requireCondition(
        pair.intents.length === 1,
        "Missing or ambiguous durable intent for a CWS receipt run.",
      );
      requireCondition(pair.results.length <= 1, "Ambiguous receipt results.");
    }
    const history: HistoryEntry[] = [];
    for (const pair of runs.values()) {
      const artifact = pair.intents[0]!;
      const intent = parse(
        receiptSchema,
        JSON.parse((await this.download(artifact, "intent.json")).toString()),
        "intent receipt",
      );
      validateReceipt(intent, {
        ...intent,
        repository: this.repository,
        itemId,
      });
      requireCondition(
        intent.outcome === "INTENT" && !intent.mutationStarted,
        "Invalid durable upload intent.",
      );
      await this.verifyRun(intent, artifact);
      const matches = pair.results;
      if (!matches.length) {
        history.push({ receipt: intent, complete: false });
        continue;
      }
      const result = validateReceipt(
        JSON.parse(
          (await this.download(matches[0]!, "result.json")).toString(),
        ),
        intent,
      );
      await this.verifyRun(result, matches[0]!);
      requireCondition(
        result.runId === intent.runId &&
          result.workflowSha === intent.workflowSha &&
          result.action === intent.action &&
          JSON.stringify(result.package) === JSON.stringify(intent.package),
        "Result provenance differs from the durable intent.",
      );
      history.push({ receipt: result, complete: true });
    }
    return history;
  }
  async restorePackage(receipt: Receipt) {
    const raw: unknown = await (
      await this.request(`actions/artifacts/${receipt.package.artifactId}`)
    ).json();
    const artifact = parse(artifactSchema, raw, "checked package artifact");
    requireCondition(
      artifact.id.toString() === receipt.package.artifactId &&
        artifact.name === receipt.package.artifactName &&
        artifact.digest === receipt.package.artifactDigest &&
        artifact.workflow_run.id.toString() === receipt.runId &&
        artifact.workflow_run.head_sha === receipt.workflowSha,
      "Checked package artifact provenance mismatch.",
    );
    const bytes = await this.download(artifact, receipt.package.zipName);
    requireCondition(
      sha256(bytes) === receipt.package.zipSha256,
      "Original checked zip digest mismatch.",
    );
    const file = path.resolve(".release", receipt.package.zipName);
    await writeFile(file, bytes);
    return file;
  }
}

export async function checkedZip(file: string, version: string) {
  requireCondition(
    path.basename(file) === `github-pulls-show-reviewers-${version}-chrome.zip`,
    "Checked package filename/version mismatch.",
  );
  const manifest: unknown = JSON.parse(
    execFileSync("unzip", ["-p", file, "manifest.json"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  );
  const parsed = parse(
    z.object({ version: z.literal(version) }),
    manifest,
    "checked manifest version",
  );
  return { version: parsed.version, zipSha256: sha256(await readFile(file)) };
}
