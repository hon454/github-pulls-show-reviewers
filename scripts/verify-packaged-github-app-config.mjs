#!/usr/bin/env node
/* global console, process */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const requiredEnv = [
  "WXT_GITHUB_APP_CLIENT_ID",
  "WXT_GITHUB_APP_SLUG",
  "WXT_GITHUB_APP_NAME",
];

const forbiddenMarkers = [
  "Iv1.devclientdev",
  "github-pulls-show-reviewers-dev",
  "WXT_GITHUB_APP_CLIENT_ID",
  "WXT_GITHUB_APP_SLUG",
  "TESTING_CLIENT_ID",
  "test-app",
];

const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  fail([`Missing required GitHub App build vars: ${missingEnv.join(", ")}`]);
}

const zipPath = resolveZipPath(process.argv[2]);
const entries = listZipEntries(zipPath);
const manifestEntry = entries.find((entry) => entry === "manifest.json");
if (!manifestEntry) {
  fail([`Package does not contain manifest.json: ${zipPath}`]);
}

const manifest = JSON.parse(readZipEntry(zipPath, manifestEntry));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const textEntries = entries.filter((entry) => /\.(html|js|json)$/i.test(entry));
const packageText = textEntries
  .map((entry) => readZipEntry(zipPath, entry))
  .join("\n");

const errors = [];

if (manifest.version !== packageJson.version) {
  errors.push(
    `manifest.json version ${manifest.version} does not match package.json version ${packageJson.version}`,
  );
}

for (const name of requiredEnv) {
  const value = process.env[name];
  if (!packageText.includes(value)) {
    errors.push(`${name} is not embedded in the packaged extension`);
  }
}

for (const marker of forbiddenMarkers) {
  if (packageText.includes(marker)) {
    errors.push(`Forbidden build marker found in package: ${marker}`);
  }
}

if (errors.length > 0) {
  fail(["packaged GitHub App config is invalid", ...errors]);
}

console.log(`Verified GitHub App config in ${zipPath}`);

function resolveZipPath(inputPath) {
  if (inputPath) {
    if (!existsSync(inputPath)) {
      fail([`Package zip does not exist: ${inputPath}`]);
    }
    return inputPath;
  }

  const outputDir = ".output";
  if (!existsSync(outputDir)) {
    fail([`No .output directory found. Run pnpm zip first.`]);
  }

  const candidates = readdirSync(outputDir)
    .filter((name) => name.endsWith("-chrome.zip"))
    .map((name) => path.join(outputDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (candidates.length === 0) {
    fail([`No Chrome extension zip found under .output. Run pnpm zip first.`]);
  }

  return candidates[0];
}

function listZipEntries(zipPath) {
  try {
    return execFileSync("unzip", ["-Z1", zipPath], {
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    fail([`Unable to list package zip entries: ${error.message}`]);
  }
}

function readZipEntry(zipPath, entry) {
  try {
    return execFileSync("unzip", ["-p", zipPath, entry], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    fail([`Unable to read ${entry} from package zip: ${error.message}`]);
  }
}

function fail(messages) {
  console.error(messages.join("\n"));
  process.exit(1);
}
