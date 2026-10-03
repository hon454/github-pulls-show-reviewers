import type { BrowserContext, Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeInstallOptionsPage,
  waitForInstallOptionsPage,
} from "./helpers/install-options-page";

const optionsUrl = "chrome-extension://abcdefghijklmnop/options.html";

function fakePage(initialUrl: string) {
  let url = initialUrl;
  const page = {
    url: () => url,
    close: vi.fn(async () => undefined),
    navigate(next: string) {
      url = next;
    },
  };
  return page;
}

function fakeContext(pages: Array<ReturnType<typeof fakePage>>) {
  const worker = {
    url: () => "chrome-extension://abcdefghijklmnop/background.js",
  };
  return {
    serviceWorkers: () => [worker],
    waitForEvent: vi.fn(async () => worker),
    pages: () => pages as unknown as Page[],
  } as unknown as BrowserContext;
}

describe("install-time options page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the blank tab to become the options page instead of a new page event", async () => {
    const blank = fakePage("about:blank");
    const closing = closeInstallOptionsPage(fakeContext([blank]));

    // Later than any fixed settle window, and announced by no page event.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(blank.close).not.toHaveBeenCalled();
    blank.navigate(optionsUrl);
    await vi.advanceTimersByTimeAsync(100);
    await closing;

    expect(blank.close).toHaveBeenCalledTimes(1);
  });

  it("returns the options page and leaves every other page open", async () => {
    const github = fakePage("https://github.com/octo/repo/pulls");
    const otherExtensionPage = fakePage(
      "chrome-extension://abcdefghijklmnop/popup.html",
    );
    const options = fakePage(optionsUrl);
    const context = fakeContext([github, otherExtensionPage, options]);

    await expect(waitForInstallOptionsPage(context)).resolves.toBe(options);
    await closeInstallOptionsPage(context);

    expect(options.close).toHaveBeenCalledTimes(1);
    expect(github.close).not.toHaveBeenCalled();
    expect(otherExtensionPage.close).not.toHaveBeenCalled();
  });

  it("waits for the service worker when it has not registered yet", async () => {
    const options = fakePage(optionsUrl);
    const worker = {
      url: () => "chrome-extension://abcdefghijklmnop/background.js",
    };
    const context = {
      serviceWorkers: () => [],
      waitForEvent: vi.fn(async () => worker),
      pages: () => [options] as unknown as Page[],
    } as unknown as BrowserContext;

    await expect(waitForInstallOptionsPage(context)).resolves.toBe(options);
    expect(context.waitForEvent).toHaveBeenCalledWith("serviceworker");
  });

  it("fails when the extension never opens its options page", async () => {
    const blank = fakePage("about:blank");
    const waiting = waitForInstallOptionsPage(fakeContext([blank]), 2_000);
    const rejection = expect(waiting).rejects.toThrow(
      "did not open its options page",
    );

    await vi.advanceTimersByTimeAsync(2_100);
    await rejection;
    expect(blank.close).not.toHaveBeenCalled();
  });
});
