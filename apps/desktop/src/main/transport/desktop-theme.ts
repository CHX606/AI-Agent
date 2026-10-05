import { BrowserWindow, ipcMain, Menu, nativeTheme } from "electron";
import type { ColorTheme } from "../../shared/contracts.js";
import type { DesktopServices } from "../application/ports.js";
import { themeBackground, titleBar } from "./desktop-window.js";

export function registerDesktopTheme(services: DesktopServices): () => ColorTheme {
  const { loadTheme, saveTheme, diagnostics } = services;
  let activeTheme = loadTheme();
  nativeTheme.themeSource = activeTheme;
  Menu.setApplicationMenu(null);
  ipcMain.on("theme:get", (event) => { event.returnValue = activeTheme; });
  ipcMain.on("theme:set", (event, theme: ColorTheme) => {
    if (theme !== "light" && theme !== "dark") return;
    activeTheme = theme;
    nativeTheme.themeSource = theme;
    const window = BrowserWindow.fromWebContents(event.sender);
    window?.setBackgroundColor(themeBackground(theme));
    // 切换主题时标题栏右上角的系统按钮也换成同色底。
    try { window?.setTitleBarOverlay(titleBar(theme)); } catch { /* 不支持叠加标题栏的平台忽略 */ }
    try { saveTheme(theme); }
    catch (error) { diagnostics.failure("preferences_save_failed", error); }
  });
  return () => activeTheme;
}
