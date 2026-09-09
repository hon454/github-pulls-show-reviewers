import { writeFile } from "node:fs/promises";

import type { TestInfo } from "@playwright/test";

type CanaryArtifactTarget = Pick<TestInfo, "attach" | "outputPath">;

export async function attachCanaryDiagnostics(
  testInfo: CanaryArtifactTarget,
  diagnostics: object,
  fileName = "canary-diagnostics.json",
): Promise<string> {
  return attachCanaryTextArtifact(
    testInfo,
    JSON.stringify(diagnostics, null, 2),
    fileName,
    "application/json",
  );
}

export async function attachCanaryTextArtifact(
  testInfo: CanaryArtifactTarget,
  content: string,
  fileName: string,
  contentType: string,
): Promise<string> {
  const artifactPath = testInfo.outputPath(fileName);
  await writeFile(artifactPath, content);
  await testInfo.attach(fileName, {
    path: artifactPath,
    contentType,
  });
  return artifactPath;
}
