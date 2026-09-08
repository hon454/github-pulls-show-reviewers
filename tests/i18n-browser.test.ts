// @vitest-environment jsdom
import { act, renderHook, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getLocaleStore } from "../src/i18n/browser";
import { useLocale } from "../src/i18n/react";
import { DEFAULT_PREFERENCES } from "../src/shared/preferences";
import { disposeUIClient } from "../src/runtime/ui-client";
import {
  createUIBridgeHarness,
  containsSecret,
  drain,
} from "./helpers/ui-bridge-harness";
let harness: ReturnType<typeof createUIBridgeHarness>;
afterEach(async () => {
  cleanup();
  getLocaleStore().dispose();
  disposeUIClient();
  harness.dispose();
  await drain();
  vi.unstubAllGlobals();
});
it("shares a safe subscription across React/DOM and patches only committed preferences", async () => {
  harness = createUIBridgeHarness({
    preferences: {
      ...DEFAULT_PREFERENCES,
      showStateBadge: false,
      openPullsOnly: false,
    },
  });
  harness.browserMock.i18n.getUILanguage = () => "zh-Hant-HK";
  const store = getLocaleStore();
  expect(getLocaleStore()).toBe(store);
  const first = renderHook(() => useLocale(store));
  const second = renderHook(() => useLocale(store));
  await act(() => store.ready());
  expect(first.result.current.lang).toBe("zh-TW");
  // The only raw storage listener belongs to the real background bridge.
  expect(harness.changes.listeners.size).toBe(1);
  await act(async () => {
    harness.changes.emit(
      { preferences: { newValue: { ...DEFAULT_PREFERENCES, language: "ja" } } },
      "sync",
    );
    harness.changes.emit({ "account:profile:test": { newValue: {} } }, "local");
    await drain();
  });
  expect(first.result.current.lang).toBe("zh-TW");
  await act(() => store.setLanguage("ko"));
  expect(first.result.current.locale).toBe("ko");
  expect(second.result.current.locale).toBe("ko");
  expect(harness.browserMock.runtime.sendMessage).toHaveBeenCalledWith({
    type: "patchPreferences",
    patch: { language: "ko" },
  });
  expect(harness.storage.snapshot().preferences).toEqual({
    ...DEFAULT_PREFERENCES,
    showStateBadge: false,
    openPullsOnly: false,
    language: "ko",
  });
  const notificationsBeforeRemoval =
    harness.notifications.get("options-1")?.length ?? 0;
  await act(async () => {
    await harness.browserMock.storage.local.remove("preferences");
  });
  // The real bridge queues storage reads and asynchronous digest computation.
  // Wait for the subscription's committed result, not one event-loop tick.
  await waitFor(() => {
    expect(first.result.current.locale).toBe("zh_TW");
    expect(second.result.current.locale).toBe("zh_TW");
  });
  expect(
    harness.notifications.get("options-1")?.slice(notificationsBeforeRemoval),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "snapshot",
        snapshot: expect.objectContaining({
          preferences: expect.objectContaining({ language: "auto" }),
        }),
      }),
    ]),
  );
  first.unmount();
  second.unmount();
  expect(containsSecret([...harness.notifications.values()])).toBe(false);
  store.dispose();
  const fresh = getLocaleStore();
  expect(fresh).not.toBe(store);
  store.dispose();
  expect(getLocaleStore()).toBe(fresh);
});
