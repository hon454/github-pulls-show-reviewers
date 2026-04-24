import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const scriptPath = path.join(projectRoot, "scripts/publish-cws.sh");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

describe("Chrome Web Store publish script", () => {
  it("uploads the release zip and submits it with DEFAULT_PUBLISH", async () => {
    const tempDir = await createTempDir();
    await stageReleaseZip(tempDir);
    const curlLogPath = path.join(tempDir, "curl.log");

    await writeExecutable(
      path.join(tempDir, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$CURL_LOG"
printf '%s\\n' '---' >> "$CURL_LOG"
url="\${@: -1}"
case "$url" in
  *":upload")
    printf '{"uploadState":"SUCCEEDED","crxVersion":"1.4.1"}'
    ;;
  *":publish")
    printf '{"state":"PENDING_REVIEW"}'
    ;;
  *)
    echo "unexpected url: $url" >&2
    exit 22
    ;;
esac
`,
    );

    const result = await runProcess("bash", [scriptPath], {
      cwd: tempDir,
      env: {
        ...withPath(tempDir),
        ...requiredCwsEnv(),
        CURL_LOG: curlLogPath,
      },
    });

    expect(result.code).toBe(0);
    const curlLog = await readFile(curlLogPath, "utf8");
    expect(curlLog).toContain(
      "https://chromewebstore.googleapis.com/upload/v2/publishers/publisher-123/items/extension-456:upload",
    );
    expect(curlLog).toContain(
      "https://chromewebstore.googleapis.com/v2/publishers/publisher-123/items/extension-456:publish",
    );
    expect(curlLog).toContain(`--data-binary`);
    expect(curlLog).toContain("@.output/github-pulls-show-reviewers-1.4.1-chrome.zip");
    expect(curlLog).toContain(`{"publishType":"DEFAULT_PUBLISH"}`);
  });

  it("polls fetchStatus when the upload is in progress and succeeds once it completes", async () => {
    const tempDir = await createTempDir();
    await stageReleaseZip(tempDir);
    const curlLogPath = path.join(tempDir, "curl.log");
    const counterPath = path.join(tempDir, "fetchstatus-counter");

    await writeExecutable(
      path.join(tempDir, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$CURL_LOG"
printf '%s\\n' '---' >> "$CURL_LOG"
url="\${@: -1}"
case "$url" in
  *":upload")
    printf '{"uploadState":"IN_PROGRESS"}'
    ;;
  *":fetchStatus")
    count=0
    if [ -f "$COUNTER_FILE" ]; then
      count="$(cat "$COUNTER_FILE")"
    fi
    echo "$((count + 1))" > "$COUNTER_FILE"
    if [ "$count" -eq 0 ]; then
      printf '{"lastAsyncUploadState":"IN_PROGRESS"}'
    else
      printf '{"lastAsyncUploadState":"SUCCEEDED"}'
    fi
    ;;
  *":publish")
    printf '{"state":"PENDING_REVIEW"}'
    ;;
  *)
    echo "unexpected url: $url" >&2
    exit 22
    ;;
esac
`,
    );

    const result = await runProcess("bash", [scriptPath], {
      cwd: tempDir,
      env: {
        ...withPath(tempDir),
        ...requiredCwsEnv(),
        CWS_UPLOAD_POLL_SECONDS: "0",
        CURL_LOG: curlLogPath,
        COUNTER_FILE: counterPath,
      },
    });

    expect(result.code).toBe(0);
    const curlLog = await readFile(curlLogPath, "utf8");
    expect(curlLog).toContain(":fetchStatus");
    expect(curlLog).toContain(":publish");
    const fetchStatusCount = (await readFile(counterPath, "utf8")).trim();
    expect(fetchStatusCount).toBe("2");
  });

  it("fails fast when fetchStatus returns an empty upload state", async () => {
    const tempDir = await createTempDir();
    await stageReleaseZip(tempDir);
    const curlLogPath = path.join(tempDir, "curl.log");

    await writeExecutable(
      path.join(tempDir, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$CURL_LOG"
printf '%s\\n' '---' >> "$CURL_LOG"
url="\${@: -1}"
case "$url" in
  *":upload")
    printf '{"uploadState":"IN_PROGRESS"}'
    ;;
  *":fetchStatus")
    printf '{}'
    ;;
  *":publish")
    printf '{"state":"PENDING_REVIEW"}'
    ;;
  *)
    echo "unexpected url: $url" >&2
    exit 22
    ;;
esac
`,
    );

    const result = await runProcess("bash", [scriptPath], {
      cwd: tempDir,
      env: {
        ...withPath(tempDir),
        ...requiredCwsEnv(),
        CWS_UPLOAD_POLL_SECONDS: "0",
        CWS_UPLOAD_POLL_ATTEMPTS: "3",
        CURL_LOG: curlLogPath,
      },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Unexpected Chrome Web Store upload state");
    const curlLog = await readFile(curlLogPath, "utf8");
    expect(curlLog).not.toContain(":publish");
  });

  it("fails when the publish response contains itemError", async () => {
    const tempDir = await createTempDir();
    await stageReleaseZip(tempDir);
    const curlLogPath = path.join(tempDir, "curl.log");

    await writeExecutable(
      path.join(tempDir, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$CURL_LOG"
printf '%s\\n' '---' >> "$CURL_LOG"
url="\${@: -1}"
case "$url" in
  *":upload")
    printf '{"uploadState":"SUCCEEDED","crxVersion":"1.4.1"}'
    ;;
  *":publish")
    printf '{"itemError":[{"error_code":"ITEM_NOT_UPDATABLE","error_detail":"Item is not updatable."}]}'
    ;;
  *)
    echo "unexpected url: $url" >&2
    exit 22
    ;;
esac
`,
    );

    const result = await runProcess("bash", [scriptPath], {
      cwd: tempDir,
      env: {
        ...withPath(tempDir),
        ...requiredCwsEnv(),
        CURL_LOG: curlLogPath,
      },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("ITEM_NOT_UPDATABLE");
    expect(result.stderr).toContain("Item is not updatable");
  });

  it("fails when the publish response has an unexpected state", async () => {
    const tempDir = await createTempDir();
    await stageReleaseZip(tempDir);
    const curlLogPath = path.join(tempDir, "curl.log");

    await writeExecutable(
      path.join(tempDir, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$CURL_LOG"
printf '%s\\n' '---' >> "$CURL_LOG"
url="\${@: -1}"
case "$url" in
  *":upload")
    printf '{"uploadState":"SUCCEEDED","crxVersion":"1.4.1"}'
    ;;
  *":publish")
    printf '{"state":"REJECTED"}'
    ;;
  *)
    echo "unexpected url: $url" >&2
    exit 22
    ;;
esac
`,
    );

    const result = await runProcess("bash", [scriptPath], {
      cwd: tempDir,
      env: {
        ...withPath(tempDir),
        ...requiredCwsEnv(),
        CURL_LOG: curlLogPath,
      },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unexpected state: REJECTED");
  });

  it("fails when the publish response has no state or itemError", async () => {
    const tempDir = await createTempDir();
    await stageReleaseZip(tempDir);
    const curlLogPath = path.join(tempDir, "curl.log");

    await writeExecutable(
      path.join(tempDir, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$CURL_LOG"
printf '%s\\n' '---' >> "$CURL_LOG"
url="\${@: -1}"
case "$url" in
  *":upload")
    printf '{"uploadState":"SUCCEEDED","crxVersion":"1.4.1"}'
    ;;
  *":publish")
    printf '{}'
    ;;
  *)
    echo "unexpected url: $url" >&2
    exit 22
    ;;
esac
`,
    );

    const result = await runProcess("bash", [scriptPath], {
      cwd: tempDir,
      env: {
        ...withPath(tempDir),
        ...requiredCwsEnv(),
        CURL_LOG: curlLogPath,
      },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("publish response missing state");
  });

  it.each(["STAGED", "PUBLISHED", "PUBLISHED_TO_TESTERS"])(
    "accepts %s as a successful publish state",
    async (successState) => {
      const tempDir = await createTempDir();
      await stageReleaseZip(tempDir);
      const curlLogPath = path.join(tempDir, "curl.log");

      await writeExecutable(
        path.join(tempDir, "curl"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$CURL_LOG"
printf '%s\\n' '---' >> "$CURL_LOG"
url="\${@: -1}"
case "$url" in
  *":upload")
    printf '{"uploadState":"SUCCEEDED","crxVersion":"1.4.1"}'
    ;;
  *":publish")
    printf '{"state":"${successState}"}'
    ;;
  *)
    echo "unexpected url: $url" >&2
    exit 22
    ;;
esac
`,
      );

      const result = await runProcess("bash", [scriptPath], {
        cwd: tempDir,
        env: {
          ...withPath(tempDir),
          ...requiredCwsEnv(),
          CURL_LOG: curlLogPath,
        },
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`state: ${successState}`);
    },
  );

  it("fails when fetchStatus returns NOT_FOUND", async () => {
    const tempDir = await createTempDir();
    await stageReleaseZip(tempDir);
    const curlLogPath = path.join(tempDir, "curl.log");

    await writeExecutable(
      path.join(tempDir, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$CURL_LOG"
printf '%s\\n' '---' >> "$CURL_LOG"
url="\${@: -1}"
case "$url" in
  *":upload")
    printf '{"uploadState":"IN_PROGRESS"}'
    ;;
  *":fetchStatus")
    printf '{"lastAsyncUploadState":"NOT_FOUND"}'
    ;;
  *":publish")
    printf '{"state":"PENDING_REVIEW"}'
    ;;
  *)
    echo "unexpected url: $url" >&2
    exit 22
    ;;
esac
`,
    );

    const result = await runProcess("bash", [scriptPath], {
      cwd: tempDir,
      env: {
        ...withPath(tempDir),
        ...requiredCwsEnv(),
        CWS_UPLOAD_POLL_SECONDS: "0",
        CURL_LOG: curlLogPath,
      },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("NOT_FOUND");
    const curlLog = await readFile(curlLogPath, "utf8");
    expect(curlLog).not.toContain(":publish");
  });

  const missingEnvCases: Array<{
    missing: string;
    present: Record<string, string>;
  }> = [
    {
      missing: "CWS_ACCESS_TOKEN",
      present: {
        CWS_PUBLISHER_ID: "publisher-123",
        CWS_EXTENSION_ID: "extension-456",
      },
    },
    {
      missing: "CWS_PUBLISHER_ID",
      present: {
        CWS_ACCESS_TOKEN: "access-token",
        CWS_EXTENSION_ID: "extension-456",
      },
    },
    {
      missing: "CWS_EXTENSION_ID",
      present: {
        CWS_ACCESS_TOKEN: "access-token",
        CWS_PUBLISHER_ID: "publisher-123",
      },
    },
  ];

  it.each(missingEnvCases)(
    "fails before calling curl when $missing is missing",
    async ({ missing, present }) => {
      const tempDir = await createTempDir();
      await writeExecutable(
        path.join(tempDir, "curl"),
        `#!/usr/bin/env bash
set -euo pipefail
touch "${path.join(tempDir, "curl-ran")}"
`,
      );

      const result = await runProcess("bash", [scriptPath], {
        cwd: tempDir,
        env: {
          ...withPath(tempDir),
          ...present,
        },
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(`${missing} is required`);
      await expect(readFile(path.join(tempDir, "curl-ran"), "utf8")).rejects.toThrow();
    },
  );
});

describe("release workflow Chrome Web Store publishing", () => {
  it("authenticates to Google and runs the CWS publish script after zip packaging", async () => {
    const releaseWorkflow = await readFile(
      path.join(projectRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    expect(releaseWorkflow).toContain("google-github-actions/auth@v3");
    expect(releaseWorkflow).toContain("CWS_SERVICE_ACCOUNT_JSON");
    expect(releaseWorkflow).toContain("CWS_ACCESS_TOKEN");
    expect(releaseWorkflow).toContain("pnpm cws:publish");
  });
});

describe("package.json CWS script", () => {
  it("exposes a cws:publish script", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["cws:publish"]).toBe("bash ./scripts/publish-cws.sh");
  });
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ghpsr-cws-publish-"));
  tempDirs.push(tempDir);
  return tempDir;
}

async function stageReleaseZip(tempDir: string): Promise<void> {
  const outputDir = path.join(tempDir, ".output");
  await mkdir(outputDir);
  const zipPath = path.join(outputDir, "github-pulls-show-reviewers-1.4.1-chrome.zip");
  await writeFile(zipPath, "zip-body", "utf8");
}

function requiredCwsEnv(): Record<string, string> {
  return {
    CWS_ACCESS_TOKEN: "access-token",
    CWS_PUBLISHER_ID: "publisher-123",
    CWS_EXTENSION_ID: "extension-456",
  };
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
  options: { cwd: string; env: NodeJS.ProcessEnv },
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
