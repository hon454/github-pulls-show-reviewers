// Temporary acceptance probe for #215; removed before merge.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";

for (const scenario of ["successful-retry"]) {
  test(`artifact retention probe: ${scenario}`, async ({
    browserName,
  }, info) => {
    expect(browserName).toBe("chromium");
    const profile = await mkdtemp(path.join(os.tmpdir(), "artifact-probe-"));
    const extension = path.resolve(".output/chrome-mv3");
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
    try {
      await context.route("https://**/*", (route) => route.abort());
      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent("serviceworker"));
      const optionsUrl = `chrome-extension://${new URL(worker.url()).host}/options.html`;
      await expect
        .poll(() => context.pages().some((page) => page.url() === optionsUrl))
        .toBe(true);
      const page = await context.newPage();
      await page.setContent(
        "<h1>Artifact retention fixture</h1><button onclick=\"this.textContent='Evidence clicked'\">Record evidence</button>",
      );
      await page.getByRole("button", { name: "Record evidence" }).click();
      await expect(page.getByRole("button")).toHaveText("Evidence clicked");
      const evidence = {
        fixtureOnly: true,
        scenario,
        retry: info.retry,
        action: "Evidence clicked",
      };
      const output = info.outputPath("artifact-probe.json");
      await writeFile(output, JSON.stringify(evidence, null, 2));
      await info.attach("artifact-probe", {
        path: output,
        contentType: "application/json",
      });
      await info.attach("body-only-probe", {
        body: JSON.stringify(evidence),
        contentType: "application/json",
      });
      expect(info.retry, "intentional fixture acceptance assertion").toBe(
        scenario === "final-failure" ? 99 : 1,
      );
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}
