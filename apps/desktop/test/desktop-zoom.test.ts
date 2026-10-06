import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: {}, ipcMain: {} }));
vi.mock("../src/main/transport/browser-panes", () => ({ browserPaneFor: () => ({ relayout() {} }) }));

import { createThemePreferences } from "../src/main/infrastructure/persistence/theme-preferences";
import { APP_ZOOM_LEVELS, nextAppZoom } from "../src/main/transport/desktop-zoom";

it("steps through the same zoom levels as Chrome and stops at 50% and 200%", () => {
  expect(nextAppZoom(1, "in")).toBe(1.1);
  expect(nextAppZoom(1.1, "in")).toBe(1.25);
  expect(nextAppZoom(1, "out")).toBe(0.9);
  expect(nextAppZoom(2, "in")).toBe(2);
  expect(nextAppZoom(0.5, "out")).toBe(0.5);
  expect(nextAppZoom(1.75, "reset")).toBe(1);
  expect(APP_ZOOM_LEVELS).toContain(1);
});

it("remembers the zoom next to the theme and ignores bad values", () => {
  const directory = mkdtempSync(join(tmpdir(), "zoom-"));
  try {
    const preferences = createThemePreferences(directory);
    expect(preferences.loadZoom()).toBe(1);
    preferences.saveTheme("dark");
    preferences.saveZoom(1.25);
    expect(preferences.loadZoom()).toBe(1.25);
    expect(preferences.loadTheme()).toBe("dark");
    expect(JSON.parse(readFileSync(join(directory, "preferences.json"), "utf8"))).toEqual({ colorTheme: "dark", zoomFactor: 1.25 });
    writeFileSync(join(directory, "preferences.json"), JSON.stringify({ zoomFactor: 9 }));
    expect(preferences.loadZoom()).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
