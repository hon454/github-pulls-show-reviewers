import { describe, expect, it } from "vitest";

import config from "../wxt.config";

describe("extension manifest", () => {
  // The floor is the newest required API; docs/implementation-notes.md lists
  // the APIs behind it and those that must stay feature-detected.
  it("declares minimum_chrome_version 140", () => {
    const manifest = config.manifest;
    if (typeof manifest !== "object" || manifest instanceof Promise) {
      throw new Error("wxt.config.ts must declare a static manifest object");
    }

    expect(manifest.minimum_chrome_version).toBe("140");
  });
});
