import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ColorTheme } from "../../../shared/contracts.js";

export function createThemePreferences(directory: string) {
  function preferencesPath(): string {
    return join(directory, "preferences.json");
  }

  function read(): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(readFileSync(preferencesPath(), "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // 首次启动或损坏的偏好文件：当作空设置。
    }
    return {};
  }

  /** 只改动给定的键，保留文件里其他设置。 */
  function write(update: Record<string, unknown>): void {
    writeFileSync(preferencesPath(), `${JSON.stringify({ ...read(), ...update }, null, 2)}\n`, "utf8");
  }

  function loadTheme(): ColorTheme {
    const theme = read().colorTheme;
    // 首次启动或损坏的偏好文件都安全回退为浅色。
    return theme === "light" || theme === "dark" ? theme : "light";
  }

  function saveTheme(theme: ColorTheme): void {
    write({ colorTheme: theme });
  }

  /** 界面缩放（1 为 100%）；超出 50%–200% 或无效时回到 100%。 */
  function loadZoom(): number {
    const zoom = read().zoomFactor;
    return typeof zoom === "number" && zoom >= 0.5 && zoom <= 2 ? zoom : 1;
  }

  function saveZoom(zoom: number): void {
    write({ zoomFactor: zoom });
  }

  return { loadTheme, saveTheme, loadZoom, saveZoom };
}
