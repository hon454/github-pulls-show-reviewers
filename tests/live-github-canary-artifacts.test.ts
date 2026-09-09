import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { attachCanaryDiagnostics } from "./helpers/live-github-canary-artifacts";

describe("live canary diagnostics artifact", () => {
  it("persists diagnostics before attaching their path", async () => {
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "ghpsr-canary-artifact-"),
    );
    const attach = vi.fn(async () => undefined);
    const diagnostics = {
      phase: "assertion",
      host: { independentRowCount: 2 },
      failures: [],
    };

    try {
      const diagnosticsPath = await attachCanaryDiagnostics(
        {
          attach,
          outputPath: (...segments: string[]) =>
            path.join(outputDir, ...segments),
        },
        diagnostics,
      );

      expect(JSON.parse(await readFile(diagnosticsPath, "utf8"))).toEqual(
        diagnostics,
      );
      expect(attach).toHaveBeenCalledWith("canary-diagnostics.json", {
        path: diagnosticsPath,
        contentType: "application/json",
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
