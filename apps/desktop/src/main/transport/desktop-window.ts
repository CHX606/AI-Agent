import { app, BrowserWindow, dialog, nativeImage } from "electron";
import { join } from "node:path";
import { publicError, type DiagnosticService } from "@bit-agent/diagnostics";
import type { ColorTheme } from "../../shared/contracts.js";
import { configureExternalNavigation } from "./external-navigation.js";

export function themeBackground(theme: ColorTheme): string {
  return theme === "dark" ? "#181817" : "#f2f2ef";
}

/** 自绘标题栏的颜色和页面一致；系统窗口按钮绘制在同色底上。 */
export function titleBar(theme: ColorTheme): Electron.TitleBarOverlayOptions {
  return { color: themeBackground(theme), symbolColor: theme === "dark" ? "#c7c4bb" : "#555550", height: 32 };
}

function windowIcon(): Electron.NativeImage {
  const path = join(app.getAppPath(), "assets/icon.png");
  const icon = nativeImage.createFromPath(path);
  if (icon.isEmpty()) throw new Error(`应用图标加载失败：${path}`);
  return icon;
}

function windowOptions(currentDirectory: string, theme: ColorTheme): Electron.BrowserWindowConstructorOptions {
  return {
    show: false, width: 1240, height: 820, minWidth: 920, minHeight: 640,
    backgroundColor: themeBackground(theme), title: "Bit Agent", autoHideMenuBar: true,
    icon: windowIcon(),
    // 页面自己画 32px 的标题栏，让暗色主题的标题栏与页面一致。
    titleBarStyle: "hidden", titleBarOverlay: titleBar(theme),
    webPreferences: {
      preload: join(currentDirectory, "transport/preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  };
}

function configureWindow(window: BrowserWindow, diagnostics: DiagnosticService): void {
  configureExternalNavigation(window.webContents, diagnostics);
  if (process.platform === "win32") window.setAppDetails({
    appId: "BitAgent.Desktop",
    appIconPath: app.isPackaged ? app.getPath("exe") : join(app.getAppPath(), "assets/icon.ico"),
    appIconIndex: 0,
    relaunchCommand: app.isPackaged ? `"${app.getPath("exe")}"` : `"${app.getPath("exe")}" "${app.getAppPath()}"`,
    relaunchDisplayName: "Bit Agent",
  });
  window.once("ready-to-show", () => { if (process.env.BIT_AGENT_ACCEPTANCE_HIDDEN !== "1") window.show(); });
  window.on("focus", () => window.flashFrame(false));
  window.webContents.on("render-process-gone", (_event, details) => {
    const id = diagnostics.failure("renderer_gone", new Error(), { reason: details.reason, exit_code: details.exitCode });
    dialog.showErrorBox("界面已停止运行", publicError(id, "请重新启动应用，已保存的记录会保留"));
  });
  window.webContents.on("did-fail-load", (_event, errorCode) =>
    diagnostics.failure("renderer_load_failed", new Error(), { error_code: errorCode }));
}

export function createDesktopWindow(diagnostics: DiagnosticService,
  currentDirectory: string, theme: ColorTheme): BrowserWindow {
  const window = new BrowserWindow(windowOptions(currentDirectory, theme));
  configureWindow(window, diagnostics);
  void window.loadFile(join(currentDirectory, "../../renderer/index.html"));
  return window;
}
