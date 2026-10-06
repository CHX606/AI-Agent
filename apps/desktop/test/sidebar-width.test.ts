import { describe, expect, it } from "vitest";
import { fitSidebarWidth, sidebarWidthLimits, storedSidebarWidth } from "../src/renderer/sidebar-width";

describe("left sidebar width", () => {
  it("leaves space for the conversation and expanded inspector at desktop widths", () => {
    expect(sidebarWidthLimits(1280, 320)).toEqual({ minimum: 180, maximum: 480 });
    expect(fitSidebarWidth(520, 1280, 320)).toBe(480);
    expect(fitSidebarWidth(20, 1280, 320)).toBe(180);
  });

  it("uses the same safe range for repository and chat when the inspector is floating", () => {
    expect(fitSidebarWidth(520, 920, 0)).toBe(440);
    expect(fitSidebarWidth(310, 920, 0)).toBe(310);
    expect(fitSidebarWidth(520, 1280, 0)).toBe(520);
  });

  it("clamps against a widened inspector and keeps a usable left panel", () => {
    expect(fitSidebarWidth(480, 1280, 520)).toBe(280);
    expect(fitSidebarWidth(500, 721, 0)).toBe(241);
  });

  it("reserves the inspector minimum when the effective grid width limits its preferred size", () => {
    expect(fitSidebarWidth(520, 1051, 280)).toBe(291);
    expect(fitSidebarWidth(520, 1100, 280)).toBe(340);
    expect(fitSidebarWidth(520, 1280, 280)).toBe(520);
  });

  it("loads a valid preference and rejects corrupt or obsolete values", () => {
    expect(storedSidebarWidth("310")).toBe(310);
    for (const value of [null, "", " ", "NaN", "Infinity", "{}", "-1", "100", "521"]) {
      expect(storedSidebarWidth(value)).toBeNull();
    }
  });
});
