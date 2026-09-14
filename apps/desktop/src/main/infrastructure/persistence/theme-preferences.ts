import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ColorTheme } from "../../../shared/contracts.js";

export function createThemePreferences(directory: string) {
  function preferencesPath(): string {
    return join(directory, "preferences.json");
  }

  function loadTheme(): ColorTheme {
    try {
      const value: unknown = JSON.parse(readFileSync(preferencesPath(), "utf8"));
      if (value && typeof value === "object" && "colorTheme" in value) {
        const theme = (value as { colorTheme?: unknown }).colorTheme;
        if (theme === "light" || theme === "dark") return theme;
      }
    } catch {
      // 首次启动或损坏的偏好文件都安全回退为浅色。
    }
    return "light";
  }

  function saveTheme(theme: ColorTheme): void {
    let preferences: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(readFileSync(preferencesPath(), "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        preferences = value as Record<string, unknown>;
      }
    } catch {
      // 文件不存在或不可解析时创建新的偏好设置。
    }
    writeFileSync(
      preferencesPath(),
      `${JSON.stringify({ ...preferences, colorTheme: theme }, null, 2)}\n`,
      "utf8",
    );
  }

  return { loadTheme, saveTheme };
}
