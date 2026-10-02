import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const readConfig = () =>
  readFile(path.join(projectRoot, ".github/dependabot.yml"), "utf8");

describe("Dependabot ignore entries", () => {
  it("names a tracking issue above every ignored dependency", async () => {
    const lines = (await readConfig()).split("\n");
    const entries = lines.flatMap((line, index) =>
      /^\s+- dependency-name: /.test(line) ? [index] : [],
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const index of entries)
      expect(lines[index - 1], lines[index]).toMatch(
        /^\s+# .*Remove with #\d+\.$/,
      );
  });

  // Tripwire for #271: when typescript-eslint admits TypeScript 7, this fails
  // on the Dependabot pull request that brings it in. Remove the ignore entry
  // and this test together.
  it("keeps the TypeScript major ignore only while typescript-eslint rejects TypeScript 7", async () => {
    expect(await readConfig()).toMatch(
      /- dependency-name: typescript\n\s+update-types:\n\s+- version-update:semver-major\n/,
    );
    const manifest = createRequire(import.meta.url)(
      "typescript-eslint/package.json",
    ) as { peerDependencies: { typescript: string } };
    const upperBound = /<\s*(\d+)\.(\d+)\.(\d+)/.exec(
      manifest.peerDependencies.typescript,
    );
    expect(
      upperBound,
      "typescript-eslint no longer caps TypeScript; remove the ignore (#271)",
    ).not.toBeNull();
    const [major, minor, patch] = upperBound!.slice(1).map(Number);
    // An exclusive bound of exactly 7.0.0 still rejects TypeScript 7.
    const acceptsSeven = major > 7 || (major === 7 && minor + patch > 0);
    expect(
      acceptsSeven,
      "typescript-eslint now accepts TypeScript 7; remove the ignore (#271)",
    ).toBe(false);
  });
});
