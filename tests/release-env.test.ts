import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const wrapperPath = path.join(
  projectRoot,
  "scripts/run-with-github-app-env.sh",
);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) =>
      rm(dir, {
        recursive: true,
        force: true,
      }),
    ),
  );
  tempDirs.length = 0;
});

describe("release env wrapper", () => {
  it("loads GitHub App vars before running the wrapped command", async () => {
    const tempDir = await createTempDir();
    await writeExecutable(
      path.join(tempDir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
cat <<'EOF'
export WXT_GITHUB_APP_CLIENT_ID='client-id'
export WXT_GITHUB_APP_SLUG='pulls-show-reviewers'
export WXT_GITHUB_APP_NAME='Pulls Show Reviewers'
EOF
`,
    );
    const targetPath = path.join(tempDir, "print-env.sh");
    await writeExecutable(
      targetPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s|%s' "$WXT_GITHUB_APP_CLIENT_ID" "$WXT_GITHUB_APP_SLUG" "$WXT_GITHUB_APP_NAME"
`,
    );

    const result = await runProcess("bash", [wrapperPath, "bash", targetPath], {
      cwd: tempDir,
      env: withPath(tempDir),
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(
      "client-id|pulls-show-reviewers|Pulls Show Reviewers",
    );
  });

  it("stops before running the wrapped command when loading GitHub vars fails", async () => {
    const tempDir = await createTempDir();
    await writeExecutable(
      path.join(tempDir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
echo "gh failed" >&2
exit 1
`,
    );
    const markerPath = path.join(tempDir, "command-ran");
    const targetPath = path.join(tempDir, "touch-marker.sh");
    await writeExecutable(
      targetPath,
      `#!/usr/bin/env bash
set -euo pipefail
touch "${markerPath}"
`,
    );

    const result = await runProcess("bash", [wrapperPath, "bash", targetPath], {
      cwd: tempDir,
      env: withPath(tempDir),
    });

    expect(result.code).not.toBe(0);
    await expect(readFile(markerPath, "utf8")).rejects.toThrow();
  });

  it("stops before running the wrapped command when a required GitHub App var is empty", async () => {
    const tempDir = await createTempDir();
    await writeExecutable(
      path.join(tempDir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
cat <<'EOF'
export WXT_GITHUB_APP_CLIENT_ID='client-id'
export WXT_GITHUB_APP_SLUG='pulls-show-reviewers'
export WXT_GITHUB_APP_NAME=''
EOF
`,
    );
    const markerPath = path.join(tempDir, "command-ran");
    const targetPath = path.join(tempDir, "touch-marker.sh");
    await writeExecutable(
      targetPath,
      `#!/usr/bin/env bash
set -euo pipefail
touch "${markerPath}"
`,
    );

    const result = await runProcess("bash", [wrapperPath, "bash", targetPath], {
      cwd: tempDir,
      env: withPath(tempDir),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "Missing required GitHub App build vars: WXT_GITHUB_APP_NAME",
    );
    await expect(readFile(markerPath, "utf8")).rejects.toThrow();
  });
});

describe("package.json release scripts", () => {
  it("use the shared release env wrapper", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["build:release"]).toBe(
      "bash ./scripts/run-with-github-app-env.sh pnpm build",
    );
    expect(packageJson.scripts["verify:package-config"]).toBe(
      "node scripts/verify-packaged-github-app-config.mjs",
    );
    expect(packageJson.scripts["zip:checked"]).toBe(
      "pnpm zip && pnpm verify:package-config",
    );
    expect(packageJson.scripts["zip:release"]).toBe(
      "bash ./scripts/run-with-github-app-env.sh pnpm zip:checked",
    );
    expect(packageJson.scripts["preflight:release"]).toBe(
      "bash ./scripts/require-github-app-build-env.sh",
    );
    expect(packageJson.scripts["submit:chrome"]).toBe(
      "node --experimental-strip-types scripts/release/cli.ts execute",
    );
  });
});

describe("release workflow", () => {
  it("writes a sanitized status artifact and Summary even when observations are unavailable", async () => {
    const tempDir = await createTempDir();
    const marker = path.join(tempDir, "git-calls");
    const summary = path.join(tempDir, "summary.md");
    await writeExecutable(
      path.join(tempDir, "git"),
      `#!/bin/sh
case "$1" in
  merge-base) exit 0 ;;
  show) printf '%s' '{"version":"1.18.2"}' ;;
  ls-tree) exit 0 ;;
  *) printf '%s' 'unexpected git call' >> '${marker}'; exit 1 ;;
esac
`,
    );
    const result = await runProcess(
      process.execPath,
      [
        "--experimental-strip-types",
        path.join(projectRoot, "scripts/release/cli.ts"),
        "status",
      ],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          PATH: `${tempDir}${path.delimiter}${process.env.PATH}`,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REPOSITORY: "hon454/github-pulls-show-reviewers",
          RELEASE_WORKFLOW_SHA: "b".repeat(40),
          CHROME_EXTENSION_ID: "a".repeat(32),
          CHROME_PUBLISHER_ID: "publisher",
          GITHUB_STEP_SUMMARY: summary,
          GH_TOKEN: "",
          CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL: "",
          CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: "",
          RELEASE_INPUTS_JSON: JSON.stringify({
            chrome_web_store: "status",
            source_sha: "a".repeat(40),
            expected_version: "1.18.2",
          }),
        },
      },
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(
      await readFile(path.join(tempDir, ".release/status.json"), "utf8"),
    );
    expect(report.observationOnly).toBe(true);
    expect(report.remote.draftVersion).toBe("unknown");
    expect(report.blockers.map((b: { code: string }) => b.code)).toEqual([
      "status-unavailable",
      "provenance-unavailable",
      "listing-missing",
    ]);
    expect(await readFile(summary, "utf8")).toContain(
      "not release authorization",
    );
    await expect(readFile(marker, "utf8")).rejects.toThrow();
    for (const file of ["intent.json", "result.json", "prepared.json"])
      await expect(
        readFile(path.join(tempDir, ".release", file), "utf8"),
      ).rejects.toThrow();
  });
  it("rejects every mutating/package CLI phase when status is selected", async () => {
    for (const phase of ["prepare", "record", "execute", "dry-run"]) {
      const result = await runProcess(
        process.execPath,
        [
          "--experimental-strip-types",
          path.join(projectRoot, "scripts/release/cli.ts"),
          phase,
        ],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_REF: "refs/heads/main",
            RELEASE_INPUTS_JSON: JSON.stringify({
              chrome_web_store: "status",
              source_sha: "a".repeat(40),
              expected_version: "1.18.2",
            }),
          },
        },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "Status mode cannot enter package, receipt or mutation phases.",
      );
    }
  });
  it("isolates status into a read-only workflow job without extension lifecycle scripts", async () => {
    const workflow = await readFile(
      path.join(projectRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    const statusJob = workflow
      .split("  status:\n")[1]!
      .split("  package:\n")[0]!;
    expect(statusJob).toContain("inputs.chrome_web_store == 'status'");
    expect(statusJob).toContain("contents: read");
    expect(statusJob).toContain("actions: read");
    expect(statusJob).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts",
    );
    expect(statusJob).toContain("scripts/release/cli.ts status");
    expect(statusJob).toContain(".release/status.json");
    expect(statusJob).not.toMatch(
      /contents: write|pnpm (?:build|zip|prepare|verify:release)|action-gh-release|cli\.ts (?:prepare|record|execute)|git (?:push|tag)/,
    );
    expect(workflow.split("  package:\n")[1]).toContain(
      "inputs.chrome_web_store != 'status'",
    );
  });
  it("runs the actual CLI resolver safely for manual dispatch against a tag", async () => {
    const tempDir = await createTempDir();
    const output = path.join(tempDir, "outputs");
    const result = await runProcess(
      process.execPath,
      [
        "--experimental-strip-types",
        path.join(projectRoot, "scripts/release/cli.ts"),
        "resolve",
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF: "refs/tags/v1.16.0",
          RELEASE_INPUTS_JSON: JSON.stringify({ chrome_web_store: "skip" }),
        },
      },
    );
    expect(result.code).toBe(0);
    expect(await readFile(output, "utf8")).toContain("action=skip\n");
  });
  it("runs the GitHub App env preflight before creating the zip", async () => {
    const workflow = await readFile(
      path.join(projectRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    const preflightIndex = workflow.indexOf("run: pnpm preflight:release");
    const zipIndex = workflow.indexOf("run: pnpm zip:checked");

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(zipIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(zipIndex);
    expect(workflow).not.toContain("- run: pnpm zip\n");
  });

  it("isolates observations from the stable mutation queue across workflow versions", async () => {
    const workflow = await readFile(
      path.join(projectRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(workflow).not.toMatch(/^concurrency:/m);
    const statusJob = workflow.split("  status:\n")[1].split("  package:\n")[0];
    const packageJob = workflow.split("  package:\n")[1];
    const itemKey =
      "${{ github.repository }}-${{ vars.CWS_EXTENSION_ID || 'unconfigured' }}";
    // The old workflow-level key must remain stable for writes on older refs.
    expect(packageJob).toContain(`group: cws-${itemKey}\n`);
    expect(statusJob).toContain(`group: cws-status-${itemKey}\n`);
    for (const job of [packageJob, statusJob]) {
      expect(job).toContain("    concurrency:\n");
      expect(job).toContain("      cancel-in-progress: false\n");
    }
  });

  it("routes all CWS writes and GitHub Releases through the tested resolver", async () => {
    const workflow = await readFile(
      path.join(projectRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(workflow).toContain("default: skip");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("scripts/release/cli.ts resolve");
    expect(workflow).not.toContain("startsWith(github.ref");
    expect(workflow).not.toContain("run: pnpm submit:chrome");
    expect(
      workflow.match(/steps.package_meta.outputs.create_release == 'true'/g),
    ).toHaveLength(2);
    expect(workflow).toContain("if: steps.action.outputs.action == 'dry-run'");
    expect(workflow).toContain(
      "run: node --experimental-strip-types scripts/release/cli.ts dry-run",
    );
    expect(workflow.indexOf("name: Save durable CWS intent")).toBeLessThan(
      workflow.indexOf("name: Execute resolved CWS action"),
    );
    expect(workflow).toContain(
      "if: always() && hashFiles('.release/result.json') != ''",
    );
    expect(workflow).not.toContain("fromJSON(secrets.");
  });
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ghpsr-release-env-"));
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeExecutable(
  filePath: string,
  contents: string,
): Promise<void> {
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, 0o755);
}

function withPath(tempDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${tempDir}:${process.env.PATH ?? ""}`,
  };
}

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
