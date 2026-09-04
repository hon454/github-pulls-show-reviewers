// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getLocaleStore } from "../src/i18n/browser";
import { useLocale } from "../src/i18n/react";
import { DEFAULT_PREFERENCES } from "../src/storage/preferences";

afterEach(() => {
  getLocaleStore().dispose();
  vi.unstubAllGlobals();
});

it("shares a context listener across React/DOM, ignores other storage areas, and writes only preferences", async () => {
  const listeners = new Set<
    (changes: Record<string, { newValue?: unknown }>, area: string) => void
  >();
  let preferences = {
    ...DEFAULT_PREFERENCES,
    showStateBadge: false,
    openPullsOnly: false,
  };
  const browserMock = {
    i18n: { getUILanguage: () => "zh-Hant-HK" },
    runtime: { sendMessage: vi.fn() },
    storage: {
      local: {
        get: vi.fn(async () => ({ preferences })),
        set: vi.fn(async (items: { preferences: typeof preferences }) => {
          preferences = items.preferences;
          for (const listener of listeners)
            listener({ preferences: { newValue: preferences } }, "local");
        }),
      },
      onChanged: {
        addListener: vi.fn((listener) => listeners.add(listener)),
        removeListener: vi.fn((listener) => listeners.delete(listener)),
      },
    },
  };
  vi.stubGlobal("browser", browserMock);
  const store = getLocaleStore();
  expect(getLocaleStore()).toBe(store);
  const first = renderHook(() => useLocale(store));
  const second = renderHook(() => useLocale(store));
  await act(() => store.ready());
  expect(first.result.current.lang).toBe("zh-TW");
  expect(browserMock.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
  act(() => {
    for (const listener of listeners) {
      listener(
        { preferences: { newValue: { ...preferences, language: "ja" } } },
        "sync",
      );
      listener({ "account:profile:test": { newValue: {} } }, "local");
    }
  });
  expect(first.result.current.lang).toBe("zh-TW");
  await act(() => store.setLanguage("ko"));
  expect(first.result.current.locale).toBe("ko");
  expect(second.result.current.locale).toBe("ko");
  expect(browserMock.storage.local.set).toHaveBeenCalledWith({
    preferences: {
      ...DEFAULT_PREFERENCES,
      showStateBadge: false,
      openPullsOnly: false,
      language: "ko",
    },
  });
  expect(browserMock.runtime.sendMessage).not.toHaveBeenCalled();
  act(() => {
    for (const listener of listeners) listener({ preferences: {} }, "local");
  });
  expect(first.result.current.locale).toBe("zh_TW");
  first.unmount();
  expect(listeners.size).toBe(1);
  second.unmount();
  expect(listeners.size).toBe(0);
  store.dispose();
  const fresh = getLocaleStore();
  expect(fresh).not.toBe(store);
  // A stale disposer must not discard a newly created singleton.
  store.dispose();
  expect(getLocaleStore()).toBe(fresh);
});
