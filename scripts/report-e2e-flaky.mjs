// Surfaces Playwright tests that only passed on retry. Report only: flaky
// tests never fail the job (see CONTRIBUTING.md "Flaky E2E tests").
/* global console, process */
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function collectFlaky(report) {
  const flaky = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? [])
        if (test.status === "flaky")
          flaky.push({
            // Spec paths are relative to the Playwright testDir.
            file: `tests/e2e/${spec.file}`,
            line: spec.line,
            title: spec.title,
            project: test.projectName,
            attempts: (test.results ?? []).map((result) => result.status),
          });
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return flaky;
}

export function summarize(flaky) {
  if (flaky.length === 0)
    return "## Flaky E2E tests\n\nNone. Every test passed on its first attempt.\n";
  return [
    "## Flaky E2E tests",
    "",
    `${flaky.length} test(s) passed only on retry. Download the retry trace from this run's \`ci-e2e-*\` artifact.`,
    "",
    "| Test | Location | Attempts |",
    "| --- | --- | --- |",
    ...flaky.map(
      (test) =>
        `| ${test.title.replaceAll("|", "\\|")} | \`${test.file}:${test.line}\` | ${test.attempts.join(" → ")} |`,
    ),
    "",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const path = process.argv[2];
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A run that never reached the reporter has nothing to summarize.
    console.log(
      `No Playwright JSON report at ${path}; skipping flaky summary.`,
    );
    process.exit(0);
  }
  const flaky = collectFlaky(report);
  const summary = summarize(flaky);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  for (const test of flaky)
    console.log(
      `::warning file=${test.file},line=${test.line},title=Flaky E2E test::${test.title} passed only on retry.`,
    );
}
