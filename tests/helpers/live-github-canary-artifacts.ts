import { writeFile } from "node:fs/promises";

import type { TestInfo } from "@playwright/test";

type CanaryArtifactTarget = Pick<TestInfo, "attach" | "outputPath">;

export async function attachCanaryDiagnostics(
  testInfo: CanaryArtifactTarget,
  diagnostics: object,
): Promise<string> {
  const diagnosticsPath = testInfo.outputPath("canary-diagnostics.json");
  await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2));
  await testInfo.attach("canary-diagnostics.json", {
    path: diagnosticsPath,
    contentType: "application/json",
  });
  return diagnosticsPath;
}
