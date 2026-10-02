import { describe, expect, it } from "vitest";

import { collectFlaky, summarize } from "../scripts/report-e2e-flaky.mjs";

const spec = (title: string, status: string, attempts: string[]) => ({
  title,
  file: "options-localization.spec.ts",
  line: 22,
  tests: [
    {
      projectName: "default",
      status,
      results: attempts.map((attempt) => ({ status: attempt })),
    },
  ],
});

describe("flaky E2E report", () => {
  it("collects only tests that passed on retry, including nested suites", () => {
    const flaky = collectFlaky({
      suites: [
        {
          specs: [spec("stable", "expected", ["passed"])],
          suites: [
            {
              specs: [
                spec("retried | once", "flaky", ["timedOut", "passed"]),
                spec("broken", "unexpected", ["failed", "failed"]),
              ],
            },
          ],
        },
      ],
    });

    expect(flaky).toEqual([
      {
        file: "tests/e2e/options-localization.spec.ts",
        line: 22,
        title: "retried | once",
        project: "default",
        attempts: ["timedOut", "passed"],
      },
    ]);
    const summary = summarize(flaky);
    expect(summary).toContain("1 test(s) passed only on retry");
    expect(summary).toContain("retried \\| once");
    expect(summary).toContain("timedOut → passed");
  });

  it("states plainly when nothing was flaky", () => {
    expect(collectFlaky({})).toEqual([]);
    expect(summarize([])).toContain("None.");
  });
});
