import { execFileSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { createCwsAdapter } from "./cws.ts";
import { executeRelease } from "./engine.ts";
import { selectPriorReceipt } from "./readiness.ts";
import { assessListingBaseline, listingBaselinePath } from "./listing.ts";
import { observeRelease, statusSummary, targetSchema } from "./status.ts";
import { checkedZip, GitHubProvenance } from "./provenance.ts";
import type { HistoryEntry } from "./provenance.ts";
import {
  evidenceSchema,
  parse,
  receiptSchema,
  ReleaseError,
  requireCondition,
  resolveAction,
  shaSchema,
  validateReceipt,
  versionSchema,
} from "./policy.ts";
import type { Receipt } from "./policy.ts";

const env = process.env;
const required = (name: string) => {
  requireCondition(env[name], `Required release input ${name} is missing.`);
  return env[name];
};
const sourceDir = path.resolve("release-source");
const inputsSchema = z.strictObject({
  tag: z.string().optional(),
  chrome_web_store: z.string().optional(),
  source_sha: z.string().optional(),
  expected_version: z.string().optional(),
  receipt_run_id: z.string().optional(),
  listing_evidence: z.string().optional(),
});
let inputs: z.infer<typeof inputsSchema>;
let plan!: ReturnType<typeof resolveAction>;
function resolve() {
  inputs = parse(
    inputsSchema,
    JSON.parse(env.RELEASE_INPUTS_JSON || "{}"),
    "workflow inputs",
  );
  requireCondition(
    !inputs.listing_evidence || inputs.chrome_web_store === "submit-existing",
    "Listing evidence is only accepted by submit-existing.",
  );
  requireCondition(
    inputs.chrome_web_store !== "submit-existing" || inputs.listing_evidence,
    "submit-existing requires explicit listing-ready evidence.",
  );
  plan = resolveAction({
    event: required("GITHUB_EVENT_NAME"),
    ref: required("GITHUB_REF"),
    ...(inputs.chrome_web_store ? { action: inputs.chrome_web_store } : {}),
    ...(inputs.tag ? { tag: inputs.tag } : {}),
    ...(inputs.source_sha ? { sourceSha: inputs.source_sha } : {}),
    ...(inputs.expected_version
      ? { expectedVersion: inputs.expected_version }
      : {}),
    ...(inputs.receipt_run_id ? { receiptRunId: inputs.receipt_run_id } : {}),
  });
}
const output = async (key: string, value: string) => {
  requireCondition(!/[\r\n]/.test(value), "Unsafe workflow output.");
  await appendFile(required("GITHUB_OUTPUT"), `${key}=${value}\n`);
};
const save = async (file: string, data: unknown) => {
  await mkdir(".release", { recursive: true });
  await writeFile(`.release/${file}`, `${JSON.stringify(data, null, 2)}\n`);
};
const load = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(`.release/${file}`, "utf8"));
const git = (...args: string[]) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const trustCommit = (sha: string) => {
  parse(shaSchema, sha, "trusted source commit");
  try {
    git("merge-base", "--is-ancestor", sha, "refs/remotes/origin/main");
  } catch {
    throw new ReleaseError(
      "Release workflow and source commits must be reachable from freshly fetched origin/main before CWS mutation.",
    );
  }
};
const github = () =>
  new GitHubProvenance(
    required("GITHUB_REPOSITORY"),
    required("GH_TOKEN"),
    trustCommit,
  );

async function status() {
  requireCondition(
    plan.action === "status",
    "Status requires the explicit read-only action.",
  );
  const target = parse(
    targetSchema,
    {
      repository: required("GITHUB_REPOSITORY"),
      sourceSha: inputs.source_sha,
      version: inputs.expected_version,
      publisherId: required("CHROME_PUBLISHER_ID"),
      itemId: required("CHROME_EXTENSION_ID"),
    },
    "status target",
  );
  trustCommit(target.sourceSha);
  const sourcePackage = parse(
    z.object({ version: versionSchema }),
    JSON.parse(git("show", `${target.sourceSha}:package.json`)),
    "status source package",
  );
  requireCondition(
    sourcePackage.version === target.version,
    "Status source and expected version must agree.",
  );
  // Read the latest reviewed baseline from fresh main, independently of an old
  // package source or a pre-merge status implementation branch. Absence is not proof.
  let rawBaseline: unknown;
  if (
    git(
      "ls-tree",
      "--name-only",
      "refs/remotes/origin/main",
      "--",
      listingBaselinePath,
    )
  ) {
    try {
      rawBaseline = JSON.parse(
        git("show", `refs/remotes/origin/main:${listingBaselinePath}`),
      );
    } catch {
      rawBaseline = null; // Report conflicting evidence, never echo raw file data.
    }
  }
  const listing = await assessListingBaseline({
    raw: rawBaseline,
    target,
    trustSource: trustCommit,
    readSource: async (sha, file) =>
      execFileSync("git", ["show", `${sha}:${file}`], {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 30 * 1024 * 1024,
      }),
  });
  const report = await observeRelease({
    target,
    workflowSha: required("RELEASE_WORKFLOW_SHA"),
    listing,
    store: { status: () => adapter("unused-in-status-mode.zip").status() },
    history: () => github().history(target.itemId, required("GITHUB_RUN_ID")),
    verifyPackage: async (prior) => {
      await checkedZip(await github().restorePackage(prior), target.version);
    },
    ...(inputs.receipt_run_id ? { receiptRunId: inputs.receipt_run_id } : {}),
  });
  await save("status.json", report);
  await appendFile(required("GITHUB_STEP_SUMMARY"), statusSummary(report));
  console.log(
    `CWS observation: ${report.route}; ${report.blockers.length} blocker(s). Read the status artifact and Actions Summary.`,
  );
}

async function prepare() {
  const sourceSha = git("-C", sourceDir, "rev-parse", "HEAD");
  parse(shaSchema, sourceSha, "release source SHA");
  if (inputs.source_sha)
    requireCondition(
      sourceSha === inputs.source_sha,
      "Checked out source differs from the explicit release SHA.",
    );
  const packageJson = parse(
    z.object({ version: versionSchema }),
    JSON.parse(await readFile(path.join(sourceDir, "package.json"), "utf8")),
    "release package version",
  );
  const version = inputs.expected_version || packageJson.version;
  requireCondition(
    version === packageJson.version &&
      (!plan.tag || plan.tag === `v${version}`),
    "Source package, expected version and tag must agree.",
  );
  if (plan.tag)
    requireCondition(
      git("-C", sourceDir, "rev-parse", `${plan.tag}^{commit}`) === sourceSha,
      "Existing tag does not identify the checked source.",
    );
  let zip = path.join(
    sourceDir,
    ".output",
    `github-pulls-show-reviewers-${version}-chrome.zip`,
  );
  requireCondition(
    (await readdir(path.join(sourceDir, ".output"))).filter((name) =>
      name.endsWith("-chrome.zip"),
    ).length === 1,
    "Exactly one checked Chrome zip is required.",
  );
  await checkedZip(zip, version);
  let history: HistoryEntry[] = [];
  let prior: Receipt | undefined;
  if (plan.action !== "skip") {
    requireCondition(
      required("GITHUB_RUN_ATTEMPT") === "1",
      "Do not rerun a CWS workflow attempt; start a new dispatch so previous receipts are inspected.",
    );
    trustCommit(required("RELEASE_WORKFLOW_SHA"));
    trustCommit(sourceSha);
    history = await github().history(
      required("CHROME_EXTENSION_ID"),
      required("GITHUB_RUN_ID"),
    );
    prior = selectPriorReceipt(
      {
        repository: required("GITHUB_REPOSITORY"),
        sourceSha,
        version,
        publisherId: required("CHROME_PUBLISHER_ID"),
        itemId: required("CHROME_EXTENSION_ID"),
      },
      history,
      inputs.receipt_run_id,
    );
    if (prior) {
      validateReceipt(prior, {
        repository: required("GITHUB_REPOSITORY"),
        sourceSha,
        version,
        publisherId: required("CHROME_PUBLISHER_ID"),
        itemId: required("CHROME_EXTENSION_ID"),
      });
      zip = await github().restorePackage(prior);
      await checkedZip(zip, version);
      // Recheck the original package as well as the freshly built source.
      execFileSync(
        process.execPath,
        [
          path.join(sourceDir, "scripts/verify-packaged-github-app-config.mjs"),
          zip,
        ],
        { cwd: sourceDir, stdio: "inherit" },
      );
    }
  }
  const evidence = inputs.listing_evidence
    ? parse(
        evidenceSchema,
        JSON.parse(inputs.listing_evidence),
        "listing evidence",
      )
    : undefined;
  await save("prepared.json", {
    sourceSha,
    version,
    zip,
    history,
    ...(prior ? { prior } : {}),
    ...(evidence ? { evidence } : {}),
  });
  await output("zip", zip);
  await output("source_sha", sourceSha);
  await output("tag", plan.tag);
  await output("create_release", String(plan.createRelease));
  const notesPath = path.join(sourceDir, "docs/releases", `${plan.tag}.md`);
  const hasNotes =
    plan.tag &&
    (await readFile(notesPath).then(
      () => true,
      () => false,
    ));
  await output("has_notes", String(Boolean(hasNotes)));
  await output("notes_path", hasNotes ? notesPath : "");
}

async function record() {
  const prepared = (await load("prepared.json")) as {
    sourceSha: string;
    version: string;
    zip: string;
    prior?: Receipt;
  };
  const receipt = parse(
    receiptSchema,
    {
      schemaVersion: 1,
      repository: required("GITHUB_REPOSITORY"),
      workflowPath: ".github/workflows/release.yml",
      workflowSha: required("RELEASE_WORKFLOW_SHA"),
      runId: required("GITHUB_RUN_ID"),
      runAttempt: required("GITHUB_RUN_ATTEMPT"),
      runUrl: `https://github.com/${required("GITHUB_REPOSITORY")}/actions/runs/${required("GITHUB_RUN_ID")}`,
      sourceSha: prepared.sourceSha,
      version: prepared.version,
      publisherId: required("CHROME_PUBLISHER_ID"),
      itemId: required("CHROME_EXTENSION_ID"),
      action: plan.action,
      checked: true,
      timestamp: new Date().toISOString(),
      package: {
        artifactId: required("PACKAGE_ARTIFACT_ID"),
        artifactName: `chrome-package-${required("GITHUB_RUN_ID")}`,
        artifactDigest: `sha256:${required("PACKAGE_ARTIFACT_DIGEST").replace(/^sha256:/, "")}`,
        zipName: path.basename(prepared.zip),
        zipSha256: (await checkedZip(prepared.zip, prepared.version)).zipSha256,
      },
      ...(prepared.prior ? { priorReceiptRunId: prepared.prior.runId } : {}),
      upload: "NOT_ATTEMPTED",
      submission: "NOT_ATTEMPTED",
      outcome: "INTENT",
      mutationStarted: false,
    },
    "checked package intent",
  );
  await save("intent.json", receipt);
}

async function execute() {
  const prepared = (await load("prepared.json")) as {
    zip: string;
    history: HistoryEntry[];
    prior?: Receipt;
    evidence?: unknown;
  };
  const receipt = parse(
    receiptSchema,
    await load("intent.json"),
    "durable intent",
  );
  requireCondition(
    required("INTENT_ARTIFACT_ID"),
    "Durable intent artifact is required before CWS access.",
  );
  const store = adapter(prepared.zip);
  const result = await executeRelease({
    receipt,
    history: prepared.history,
    ...(prepared.prior ? { prior: prepared.prior } : {}),
    evidence: prepared.evidence,
    store,
    checkpoint: (current) =>
      save("result.json", { ...current, timestamp: new Date().toISOString() }),
  });
  await save("result.json", {
    ...result.receipt,
    timestamp: new Date().toISOString(),
  });
  if (prepared.evidence) await save("listing-evidence.json", prepared.evidence);
  console.log(
    `CWS result: ${result.receipt.outcome}. Source ${receipt.sourceSha}, version ${receipt.version}.`,
  );
  if (result.error) throw new ReleaseError(result.error);
}

function adapter(zip: string) {
  return createCwsAdapter({
    publisherId: required("CHROME_PUBLISHER_ID"),
    itemId: required("CHROME_EXTENSION_ID"),
    email: required("CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL"),
    privateKey: required("CHROME_SERVICE_ACCOUNT_PRIVATE_KEY"),
    zip,
  });
}

try {
  requireCondition(
    process.argv.length === 3,
    "Use exactly one documented release phase; extra arguments are rejected.",
  );
  resolve();
  const phase = process.argv[2];
  requireCondition(
    plan.action !== "status" || phase === "status" || phase === "resolve",
    "Status mode cannot enter package, receipt or mutation phases.",
  );
  if (phase === "resolve") {
    await output("action", plan.action);
    await output("source_ref", plan.sourceRef);
  } else if (phase === "status") await status();
  else if (phase === "dry-run") {
    requireCondition(
      plan.action === "dry-run",
      "Credential-only mode requires the explicit dry-run action.",
    );
    await adapter("unused-in-credential-only-mode.zip").dryRun();
    console.log(
      "Credential-only verification succeeded for the SDK and publish-existing adapter; no upload, publish or GitHub Release was attempted.",
    );
  } else if (phase === "prepare") await prepare();
  else if (phase === "record") await record();
  else if (phase === "execute") await execute();
  else throw new ReleaseError("Unknown release phase.");
} catch (error) {
  console.error(
    error instanceof ReleaseError
      ? error.message
      : "Release validation failed; inspect the documented inputs and durable receipts. Raw errors are suppressed.",
  );
  process.exitCode = 1;
}
