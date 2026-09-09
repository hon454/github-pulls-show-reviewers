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

  it("keeps each navigation-stage artifact instead of overwriting prior evidence", async () => {
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "ghpsr-canary-artifact-"),
    );
    const attach = vi.fn(async () => undefined);
    try {
      const aPath = await attachCanaryDiagnostics(
        {
          attach,
          outputPath: (...segments: string[]) =>
            path.join(outputDir, ...segments),
        },
        { phase: "navigation:A" },
        "canary-navigation-A.json",
      );
      const bPath = await attachCanaryDiagnostics(
        {
          attach,
          outputPath: (...segments: string[]) =>
            path.join(outputDir, ...segments),
        },
        { phase: "navigation:B" },
        "canary-navigation-B.json",
      );

      expect(aPath).not.toBe(bPath);
      expect(JSON.parse(await readFile(aPath, "utf8"))).toEqual({
        phase: "navigation:A",
      });
      expect(JSON.parse(await readFile(bPath, "utf8"))).toEqual({
        phase: "navigation:B",
      });
      expect(attach).toHaveBeenNthCalledWith(1, "canary-navigation-A.json", {
        path: aPath,
        contentType: "application/json",
      });
      expect(attach).toHaveBeenNthCalledWith(2, "canary-navigation-B.json", {
        path: bPath,
        contentType: "application/json",
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
