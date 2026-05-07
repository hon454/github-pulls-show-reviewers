import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const wrapperPath = path.join(projectRoot, "scripts/run-with-github-app-env.sh");
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
    expect(packageJson.scripts["zip:release"]).toBe(
      "bash ./scripts/run-with-github-app-env.sh pnpm zip",
    );
    expect(packageJson.scripts["preflight:release"]).toBe(
      "bash ./scripts/require-github-app-build-env.sh",
    );
  });
});

describe("release workflow", () => {
  it("runs the GitHub App env preflight before creating the zip", async () => {
    const workflow = await readFile(
      path.join(projectRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    const preflightIndex = workflow.indexOf("- run: pnpm preflight:release");
    const zipIndex = workflow.indexOf("- run: pnpm zip");

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(zipIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(zipIndex);
  });
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ghpsr-release-env-"));
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeExecutable(filePath: string, contents: string): Promise<void> {
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
