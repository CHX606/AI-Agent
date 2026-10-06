/**
 * 整个应用界面的缩放（Ctrl+= / Ctrl+- / Ctrl+0、Ctrl+滚轮），和 Chrome、Claude Code 一样的档位，重启后保留。
 * 焦点在内置浏览器的网页里时，这些快捷键缩放的是网页本身（见 browser-view.ts）。
 */
import { BrowserWindow, ipcMain } from "electron";
import type { DesktopServices } from "../application/ports.js";
import { browserPaneFor } from "./browser-panes.js";

export const APP_ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export function nextAppZoom(current: number, action: "in" | "out" | "reset"): number {
  if (action === "reset") return 1;
  if (action === "in") return APP_ZOOM_LEVELS.find((level) => level > current + 0.001) ?? APP_ZOOM_LEVELS.at(-1)!;
  return [...APP_ZOOM_LEVELS].reverse().find((level) => level < current - 0.001) ?? APP_ZOOM_LEVELS[0]!;
}

export function registerDesktopZoom(services: DesktopServices): (window: BrowserWindow) => void {
  let zoom = services.loadZoom();
  const apply = (window: BrowserWindow) => {
    if (window.isDestroyed()) return;
    window.webContents.setZoomFactor(zoom);
    // 页面坐标变了：内置浏览器的原生视图按新的缩放重新对齐。
    browserPaneFor(window).relayout();
  };
  ipcMain.handle("zoom:set", (event, action: unknown) => {
    if (action !== "in" && action !== "out" && action !== "reset") throw new Error("不支持的缩放操作");
    zoom = nextAppZoom(zoom, action);
    for (const window of BrowserWindow.getAllWindows()) apply(window);
    try { services.saveZoom(zoom); } catch (error) { services.diagnostics.failure("preferences_save_failed", error); }
    return zoom;
  });
  // 新窗口和页面重新加载后都要重新设置（缩放跟着页面走）。
  return (window) => {
    window.webContents.on("did-finish-load", () => apply(window));
  };
}
