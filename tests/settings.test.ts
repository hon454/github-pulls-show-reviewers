import { afterEach, describe, expect, it, vi } from "vitest";

import { getStoredSettings } from "../src/storage/settings";

const browserMock = {
  storage: {
    local: {
      get: vi.fn<(key?: string) => Promise<Record<string, unknown>>>(),
    },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stored settings", () => {
  it("defaults to an empty token entry list when storage is empty", async () => {
    vi.stubGlobal("browser", browserMock);
    browserMock.storage.local.get.mockResolvedValueOnce({});

    await expect(getStoredSettings()).resolves.toEqual({
      tokenEntries: [],
    });
  });

  it("does not migrate a legacy githubToken value", async () => {
    vi.stubGlobal("browser", browserMock);
    browserMock.storage.local.get.mockResolvedValueOnce({
      settings: {
        githubToken: "legacy-token",
      },
    });

    await expect(getStoredSettings()).resolves.toEqual({
      tokenEntries: [],
    });
  });
});
