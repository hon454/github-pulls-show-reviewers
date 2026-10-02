import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const workflowDir = path.join(projectRoot, ".github/workflows");

describe("CI workflow", () => {
  it("uses frozen lockfile installs in every job", async () => {
    const workflow = await readFile(
      path.join(projectRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    const installCommands = workflow
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- run: pnpm install"));

    expect(installCommands.length).toBeGreaterThan(0);
    expect(installCommands).toEqual(
      installCommands.map(() => "- run: pnpm install --frozen-lockfile"),
    );
    expect(workflow).not.toContain("--frozen-lockfile=false");
  });

  it("keeps deterministic fixture E2E as the pull-request gate", async () => {
    const workflow = await readFile(
      path.join(projectRoot, ".github/workflows/ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("pnpm test:e2e:run");
    expect(workflow).not.toContain("pnpm test:e2e:live");
  });
});

describe("live GitHub DOM canary workflow", () => {
  it("runs only on a schedule or manual dispatch with read-only permissions", async () => {
    const workflow = await readLiveCanaryWorkflow();

    expect(workflow).toContain("schedule:");
    expect(
      [...workflow.matchAll(/cron:\s*"([^"]+)"/g)].map((match) => match[1]),
    ).toEqual(["17 6 * * 1"]);
    expect(workflow).toContain("group: live-github-dom-canary");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("GITHUB_TOKEN");
    expect(workflow).toContain("persist-credentials: false");
  });

  it("builds the packaged extension before the live test and uploads failures", async () => {
    const workflow = await readLiveCanaryWorkflow();
    const buildIndex = workflow.indexOf("pnpm test:e2e:build");
    const canaryIndex = workflow.indexOf("pnpm test:e2e:live");

    expect(buildIndex).toBeGreaterThan(-1);
    expect(canaryIndex).toBeGreaterThan(buildIndex);
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("if: failure()");
    expect(workflow).toContain("if: success()");
    expect(workflow).toContain("path: test-results/**/canary-*.json");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40} # v7\./);
    expect(workflow).toContain("path: test-results");
    expect(workflow).toContain("retention-days: 14");
    expect(workflow).not.toContain("continue-on-error");
  });
});

describe("workflow supply-chain pinning", () => {
  it("pins every action to a full commit SHA with a version comment", async () => {
    const files = (await readdir(workflowDir)).filter((name) =>
      name.endsWith(".yml"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const uses = (await readFile(path.join(workflowDir, file), "utf8"))
        .split("\n")
        .filter((line) => /^\s*(?:- )?uses:/.test(line));
      expect(uses.length, file).toBeGreaterThan(0);
      for (const line of uses)
        expect(line, file).toMatch(
          /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
        );
    }
  });

  it("drops persisted credentials and checks trust before release source code runs", async () => {
    const workflow = await readFile(
      path.join(workflowDir, "release.yml"),
      "utf8",
    );
    const checkouts = workflow.split(/uses: actions\/checkout@/).slice(1);
    expect(checkouts).toHaveLength(3);
    for (const checkout of checkouts)
      expect(checkout.split("\n      - ")[0]).toContain(
        "persist-credentials: false",
      );
    const trustIndex = workflow.indexOf("scripts/release/cli.ts trust");
    expect(trustIndex).toBeGreaterThan(
      workflow.indexOf("run: git fetch origin main --tags"),
    );
    expect(trustIndex).toBeLessThan(
      workflow.indexOf("working-directory: release-source"),
    );
    expect(workflow).toContain("scripts/release/cli.ts prepare");
  });
});

async function readLiveCanaryWorkflow(): Promise<string> {
  return (
    await readFile(
      path.join(projectRoot, ".github/workflows/live-github-dom-canary.yml"),
      "utf8",
    )
  ).replace(/\r\n/g, "\n");
}
