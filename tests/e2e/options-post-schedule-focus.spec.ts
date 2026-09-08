import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";

const extensionPath = path.resolve(".output/chrome-mv3");

test("does not restore focus after external pointer intent precedes the pending effect", async ({
  browserName,
}) => {
  expect(browserName).toBe("chromium");
  const profile = await mkdtemp(
    path.join(os.tmpdir(), "ghpsr-post-schedule-focus-"),
  );
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  let releaseUser!: () => void;
  const userResponse = new Promise<void>((resolve) => {
    releaseUser = resolve;
  });
  try {
    await context.addInitScript(() => {
      const NativeMessageChannel = window.MessageChannel;
      let hold = false;
      const held: Array<() => void> = [];
      class InterceptedMessageChannel {
        constructor() {
          const channel = new NativeMessageChannel();
          const post = channel.port2.postMessage.bind(channel.port2);
          const interceptedPost = (
            ...args: Parameters<MessagePort["postMessage"]>
          ) => {
            if (hold) {
              held.push(() => post(...args));
              return;
            }
            post(...args);
          };
          channel.port2.postMessage = interceptedPost as typeof channel.port2.postMessage;
          return channel as unknown as InterceptedMessageChannel;
        }
      }
      window.MessageChannel = InterceptedMessageChannel as unknown as typeof MessageChannel;
      Object.assign(window, {
        __holdReactScheduler: () => (hold = true),
        __flushReactSchedulerTask: () => held.shift()?.(),
        __heldReactSchedulerTasks: () => held.length,
        __addFocusEvents: [] as string[],
      });
      const focus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (...args) {
        if (this.getAttribute("data-testid") === "accounts-add")
          (
            window as unknown as { __addFocusEvents: string[] }
          ).__addFocusEvents.push("add-focus");
        return focus.apply(this, args);
      };
    });
    await context.route("https://**/*", async (route) => {
      const endpoint = new URL(route.request().url()).pathname;
      if (endpoint === "/login/device/code") {
        await route.fulfill({
          json: {
            device_code: "fixture-device",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 1,
          },
        });
      } else if (endpoint === "/login/oauth/access_token") {
        await route.fulfill({
          json: {
            access_token: "fixture-access",
            refresh_token: "fixture-refresh",
            token_type: "bearer",
            expires_in: 28_800,
            refresh_token_expires_in: 15_552_000,
          },
        });
      } else if (endpoint === "/user") {
        await userResponse;
        await route.fulfill({ json: { login: "octocat", avatar_url: null } });
      } else if (endpoint === "/user/installations") {
        await route.fulfill({ json: { total_count: 0, installations: [] } });
      } else {
        await route.abort();
      }
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const url = `chrome-extension://${new URL(worker.url()).host}/options.html`;
    await expect
      .poll(() => context.pages().find((page) => page.url() === url)?.url())
      .toBe(url);
    const page = context.pages().find((item) => item.url() === url)!;
    await page.getByTestId("accounts-add").click();
    await expect(page.getByTestId("device-user-code")).toBeVisible();
    await page.getByRole("button", { name: "Copy", exact: true }).focus();
    await page.evaluate(() =>
      (window as unknown as { __holdReactScheduler(): void })
        .__holdReactScheduler(),
    );
    releaseUser();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as { __heldReactSchedulerTasks(): number }
            ).__heldReactSchedulerTasks(),
        ),
      )
      .toBeGreaterThan(0);
    await page.evaluate(() =>
      (window as unknown as { __flushReactSchedulerTask(): void })
        .__flushReactSchedulerTask(),
    );
    await expect(page.getByTestId("accounts-add")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as { __heldReactSchedulerTasks(): number }
            ).__heldReactSchedulerTasks(),
        ),
      )
      .toBeGreaterThan(0);
    await page.locator(".options-intro").dispatchEvent("pointerdown");
    await page.evaluate(() =>
      (window as unknown as { __flushReactSchedulerTask(): void })
        .__flushReactSchedulerTask(),
    );
    await page.waitForTimeout(50);
    await expect(page.locator("body")).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __addFocusEvents: string[] })
              .__addFocusEvents,
        ),
      )
      .toEqual([]);
  } finally {
    releaseUser?.();
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
