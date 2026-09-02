import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");

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
    expect(workflow).toContain("actions/upload-artifact@v7");
    expect(workflow).toContain("path: test-results");
  });
});

function readLiveCanaryWorkflow(): Promise<string> {
  return readFile(
    path.join(projectRoot, ".github/workflows/live-github-dom-canary.yml"),
    "utf8",
  );
}
