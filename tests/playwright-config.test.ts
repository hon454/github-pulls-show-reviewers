import { describe, expect, it, vi } from "vitest";

type PlaywrightConfig = {
  retries?: number;
  use?: {
    screenshot?: string;
    trace?: string;
  };
  projects?: Array<{
    name?: string;
    retries?: number;
    testIgnore?: string[];
    testMatch?: string[];
    use?: {
      screenshot?: string;
      trace?: string;
    };
  }>;
};

describe("Playwright config", () => {
  it("does not retry e2e tests by default for local runs", async () => {
    const config = await importPlaywrightConfigWithCi(undefined);

    expect(config.retries).toBe(0);
  });

  it("retries e2e tests once in CI and records traces on first retry", async () => {
    const config = await importPlaywrightConfigWithCi("true");

    expect(config.retries).toBe(1);
    expect(config.use?.trace).toBe("on-first-retry");
  });

  it("keeps the live canary out of the deterministic default project", async () => {
    const config = await importPlaywrightConfigWithCi("true");
    const defaultProject = config.projects?.find(
      (project) => project.name === "default",
    );

    expect(defaultProject?.testIgnore).toContain(
      "**/live-github-canary.spec.ts",
    );
  });

  it("retains live canary evidence and absorbs brief transient failures", async () => {
    const config = await importPlaywrightConfigWithCi("true");
    const liveProject = config.projects?.find(
      (project) => project.name === "live-github-canary",
    );

    expect(liveProject).toMatchObject({
      testMatch: ["**/live-github-canary.spec.ts"],
      retries: 2,
      use: {
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
      },
    });
  });
});

async function importPlaywrightConfigWithCi(
  ci: string | undefined,
): Promise<PlaywrightConfig> {
  const previousCi = process.env.CI;

  if (ci === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = ci;
  }
  vi.resetModules();

  try {
    const module = (await import("../playwright.config")) as {
      default: PlaywrightConfig;
    };

    return module.default;
  } finally {
    if (previousCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCi;
    }
    vi.resetModules();
  }
}
