import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StorageShape = Record<string, unknown>;

function createBrowserMock() {
  let storage: StorageShape = {};
  const get = vi.fn(async (key?: string | string[] | Record<string, unknown>) => {
    if (typeof key === "string") {
      return key in storage ? { [key]: storage[key] } : {};
    }
    return { ...storage };
  });
  const set = vi.fn(async (items: StorageShape) => {
    storage = { ...storage, ...items };
  });
  return {
    browser: { storage: { local: { get, set } } },
    reset() {
      storage = {};
      get.mockClear();
      set.mockClear();
    },
  };
}

let browserMock: ReturnType<typeof createBrowserMock>;

beforeEach(() => {
  browserMock = createBrowserMock();
  vi.stubGlobal("browser", browserMock.browser);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preferences storage", () => {
  it("returns defaults when nothing is persisted", async () => {
    const { getPreferences } = await import("../src/storage/preferences");
    await expect(getPreferences()).resolves.toEqual({
      version: 1,
      showStateBadge: true,
      showReviewerName: false,
    });
  });

  it("returns defaults when persisted payload fails schema", async () => {
    browserMock.browser.storage.local.get.mockResolvedValueOnce({
      preferences: { showStateBadge: "yes" },
    });
    const { getPreferences } = await import("../src/storage/preferences");
    await expect(getPreferences()).resolves.toEqual({
      version: 1,
      showStateBadge: true,
      showReviewerName: false,
    });
  });

  it("updatePreferences merges partial patches and preserves version", async () => {
    const { updatePreferences, getPreferences } = await import(
      "../src/storage/preferences"
    );
    const next = await updatePreferences({ showStateBadge: false });
    expect(next).toEqual({
      version: 1,
      showStateBadge: false,
      showReviewerName: false,
    });
    await expect(getPreferences()).resolves.toEqual(next);
  });

  it("updatePreferences preserves unrelated fields when toggling one", async () => {
    const { updatePreferences } = await import("../src/storage/preferences");
    await updatePreferences({ showStateBadge: false });
    const afterNameToggle = await updatePreferences({ showReviewerName: true });
    expect(afterNameToggle).toEqual({
      version: 1,
      showStateBadge: false,
      showReviewerName: true,
    });
  });
});

describe("storage change classification", () => {
  it("isPreferencesChange returns true when the preferences key is in the change map", async () => {
    const { isPreferencesChange, isAccountsChange } = await import(
      "../src/storage/preferences"
    );
    expect(
      isPreferencesChange({
        preferences: { oldValue: undefined, newValue: { version: 1 } },
      }),
    ).toBe(true);
    expect(isPreferencesChange({ settings: { oldValue: undefined, newValue: {} } })).toBe(
      false,
    );
    expect(isAccountsChange({ settings: { oldValue: undefined, newValue: {} } })).toBe(
      true,
    );
    expect(
      isAccountsChange({ "account:acc-1": { oldValue: undefined, newValue: {} } }),
    ).toBe(true);
    expect(isAccountsChange({ preferences: { oldValue: undefined, newValue: {} } })).toBe(
      false,
    );
  });
});
