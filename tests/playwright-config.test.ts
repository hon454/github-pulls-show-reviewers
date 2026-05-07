import { describe, expect, it, vi } from "vitest";

type PlaywrightConfig = {
  retries?: number;
  use?: {
    trace?: string;
  };
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
