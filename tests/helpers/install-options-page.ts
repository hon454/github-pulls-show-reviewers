import type { BrowserContext, Page } from "@playwright/test";

/**
 * A fresh profile fires `onInstalled`, which opens the options page. Chrome
 * loads it into an existing blank tab some time after the worker starts, so no
 * page event announces it and a fixed wait can end before it happens. Left
 * alone, that navigation can interrupt a test's own `goto`, and the page keeps
 * a reconnecting port open for the whole test.
 */
export async function waitForInstallOptionsPage(
  context: BrowserContext,
  timeoutMs = 15_000,
): Promise<Page> {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const url = `chrome-extension://${new URL(worker.url()).host}/options.html`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = context.pages().find((candidate) => candidate.url() === url);
    if (page != null) return page;
    if (Date.now() >= deadline)
      throw new Error(
        "The extension did not open its options page after install.",
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** For tests that start from a profile with no extension page open. */
export async function closeInstallOptionsPage(
  context: BrowserContext,
): Promise<void> {
  const page = await waitForInstallOptionsPage(context);
  await page.close();
}
