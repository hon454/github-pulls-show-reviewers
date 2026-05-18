import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runProcess } from "./utils/process";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const verifierPath = path.join(
  projectRoot,
  "scripts/verify-packaged-github-app-config.mjs",
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

describe("packaged GitHub App config verification", () => {
  it("accepts a package that embeds the configured GitHub App identifiers", async () => {
    const tempDir = await createTempDir();
    const zipPath = await createPackageZip(tempDir, {
      manifestVersion: await readPackageVersion(),
      bundle: `
        const githubApp = {
          clientId: "Iv23liezcMPzIAcjpnIr",
          slug: "pulls-show-reviewers",
          name: "Pulls Show Reviewers"
        };
      `,
    });

    const result = await runVerifier(zipPath);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Verified GitHub App config");
  });

  it("rejects a package built without production GitHub App identifiers", async () => {
    const tempDir = await createTempDir();
    const zipPath = await createPackageZip(tempDir, {
      manifestVersion: await readPackageVersion(),
      bundle: `
        const DEV_DEFAULTS = {
          clientId: "Iv1.devclientdev",
          slug: "github-pulls-show-reviewers-dev"
        };
        missing.push("WXT_GITHUB_APP_CLIENT_ID");
        missing.push("WXT_GITHUB_APP_SLUG");
      `,
    });

    const result = await runVerifier(zipPath);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("packaged GitHub App config is invalid");
    expect(result.stderr).toContain("WXT_GITHUB_APP_CLIENT_ID");
    expect(result.stderr).toContain("github-pulls-show-reviewers-dev");
  });
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ghpsr-package-"));
  tempDirs.push(tempDir);
  return tempDir;
}

async function readPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  ) as { version: string };
  return packageJson.version;
}

async function createPackageZip(
  tempDir: string,
  options: {
    manifestVersion: string;
    bundle: string;
  },
): Promise<string> {
  const packageDir = path.join(tempDir, "package");
  const chunkDir = path.join(packageDir, "chunks");
  await mkdir(chunkDir, { recursive: true });
  await writeFile(
    path.join(packageDir, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "GitHub Pulls Show Reviewers",
      version: options.manifestVersion,
    }),
    "utf8",
  );
  await writeFile(path.join(chunkDir, "options.js"), options.bundle, "utf8");

  const zipPath = path.join(tempDir, "package.zip");
  const result = await runProcess("zip", ["-qr", zipPath, "."], {
    cwd: packageDir,
    env: process.env,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || "zip failed");
  }
  return zipPath;
}

function runVerifier(zipPath: string) {
  return runProcess("node", [verifierPath, zipPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      WXT_GITHUB_APP_CLIENT_ID: "Iv23liezcMPzIAcjpnIr",
      WXT_GITHUB_APP_SLUG: "pulls-show-reviewers",
      WXT_GITHUB_APP_NAME: "Pulls Show Reviewers",
    },
  });
}
