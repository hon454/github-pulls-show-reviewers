import { writeFile } from "node:fs/promises";

import type { TestInfo } from "@playwright/test";

type CanaryArtifactTarget = Pick<TestInfo, "attach" | "outputPath">;

export async function attachCanaryDiagnostics(
  testInfo: CanaryArtifactTarget,
  diagnostics: object,
  fileName = "canary-diagnostics.json",
): Promise<string> {
  const diagnosticsPath = testInfo.outputPath(fileName);
  await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2));
  await testInfo.attach(fileName, {
    path: diagnosticsPath,
    contentType: "application/json",
  });
  return diagnosticsPath;
}
