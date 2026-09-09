import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  attachCanaryDiagnostics,
  attachCanaryTextArtifact,
} from "./helpers/live-github-canary-artifacts";
import { canaryStageArtifactFileName } from "./helpers/live-github-canary";

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

  it("keeps the original failed stage verdict separate from catch evidence", async () => {
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "ghpsr-canary-artifact-"),
    );
    const attach = vi.fn(async () => undefined);
    const stageDiagnostics = {
      phase: "navigation:C",
      failures: [{ code: "api-body-pending" }],
    };
    const catchDiagnostics = {
      phase: "navigation:C",
      failures: [{ code: "navigation-stage-failed" }],
    };

    try {
      const stagePath = await attachCanaryDiagnostics(
        {
          attach,
          outputPath: (...segments: string[]) =>
            path.join(outputDir, ...segments),
        },
        stageDiagnostics,
        canaryStageArtifactFileName("C"),
      );
      const catchPath = await attachCanaryDiagnostics(
        {
          attach,
          outputPath: (...segments: string[]) =>
            path.join(outputDir, ...segments),
        },
        catchDiagnostics,
        canaryStageArtifactFileName("C", true),
      );

      expect(stagePath).not.toBe(catchPath);
      expect(JSON.parse(await readFile(stagePath, "utf8"))).toEqual(
        stageDiagnostics,
      );
      expect(JSON.parse(await readFile(catchPath, "utf8"))).toEqual(
        catchDiagnostics,
      );
      expect(attach).toHaveBeenNthCalledWith(
        1,
        "canary-navigation-C.json",
        { path: stagePath, contentType: "application/json" },
      );
      expect(attach).toHaveBeenNthCalledWith(
        2,
        "canary-navigation-C-failure.json",
        { path: catchPath, contentType: "application/json" },
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("persists failed page HTML and attaches its output path", async () => {
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "ghpsr-canary-artifact-"),
    );
    const attach = vi.fn(async () => undefined);
    const pageHtml = "<main><h1>Pull requests</h1></main>";

    try {
      const htmlPath = await attachCanaryTextArtifact(
        {
          attach,
          outputPath: (...segments: string[]) =>
            path.join(outputDir, ...segments),
        },
        pageHtml,
        "github-pr-list.html",
        "text/html",
      );

      expect(await readFile(htmlPath, "utf8")).toBe(pageHtml);
      expect(attach).toHaveBeenCalledWith("github-pr-list.html", {
        path: htmlPath,
        contentType: "text/html",
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
