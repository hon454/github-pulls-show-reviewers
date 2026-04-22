import { describe, expect, it } from "vitest";

import { STATE_ICONS } from "../src/features/reviewers/state-icons";

describe("STATE_ICONS", () => {
  it("provides four well-formed SVG strings", () => {
    for (const key of ["approved", "changesRequested", "commented", "dismissed"] as const) {
      const svg = STATE_ICONS[key];
      expect(typeof svg).toBe("string");
      expect(svg).toMatch(/^<svg[\s>]/);
      expect(svg).toContain("</svg>");
      expect(svg).toContain('viewBox="0 0 16 16"');
    }
  });
});
