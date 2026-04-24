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
});
