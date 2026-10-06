import { app, BrowserWindow, dialog } from "electron";
import { publicError } from "@bit-agent/diagnostics";
import type { DesktopServices } from "../application/ports.js";
import { installDesktopDiagnostics, registerDesktopLifecycle } from "./desktop-lifecycle.js";
import { createDesktopWindow } from "./desktop-window.js";
import { registerDesktopTheme } from "./desktop-theme.js";
import { createIpcHandler } from "./ipc-handler.js";
import { registerDiagnosticsIpc } from "./diagnostics-ipc.js";
import { registerSettingsIpc } from "./settings-ipc.js";
import { registerRepositoryIpc } from "./repository-ipc.js";
import { registerGitIpc } from "./git-ipc.js";
import { registerTaskIpc } from "./task-ipc.js";
import { registerSessionIpc } from "./session-ipc.js";
import { registerMemoryIpc } from "./memory-ipc.js";
import { registerClipboardIpc } from "./clipboard-ipc.js";
import { createTaskWatches } from "./task-watches.js";
import { registerTerminalIpc } from "./terminal-ipc.js";

export function startDesktop(services: DesktopServices, currentDirectory: string): void {
  installDesktopDiagnostics(services);
  if (!app.requestSingleInstanceLock()) app.quit();
  // Windows 系统通知按应用编号归类；不设置时通知显示为 Electron。
  if (process.platform === "win32") app.setAppUserModelId("BitAgent.Desktop");
  const watches = createTaskWatches(services);
  app.whenReady().then(() => initializeDesktop(services, currentDirectory, watches)).catch(error => {
    const id = services.diagnostics.failure("desktop_initialization_failed", error);
    dialog.showErrorBox("启动失败", publicError(id));
    app.quit();
  });
  registerDesktopLifecycle(services, () => watches.stopAll());
}

async function initializeDesktop(services: DesktopServices, currentDirectory: string,
  watches: ReturnType<typeof createTaskWatches>): Promise<void> {
  if (!await startRuntime(services)) return;
  const handle = createIpcHandler(services.diagnostics);
  registerDiagnosticsIpc(services, handle);
  registerSettingsIpc(services, handle);
  registerGitIpc(services, handle);
  const theme = registerDesktopTheme(services);
  registerRepositoryIpc(services, handle);
  registerTaskIpc(services, handle);
  registerSessionIpc(services, handle);
  registerMemoryIpc(services, handle);
  registerClipboardIpc(handle);
  registerTerminalIpc(services, handle);
  watches.register();
  const createWindow = () => createDesktopWindow(services.diagnostics, currentDirectory, theme());
  createWindow();
  app.on("second-instance", () => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing?.isMinimized()) existing.restore();
    existing?.focus();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

async function startRuntime(services: DesktopServices): Promise<boolean> {
  const { diagnostics, saveDiagnosticBundle, startManagedRuntime, stopManagedRuntime } = services;
  try { await startManagedRuntime(); return true; }
  catch (error) {
    const id = diagnostics.failure("desktop_startup_failed", error);
    const choice = await dialog.showMessageBox({ type: "error", title: "本地服务启动失败",
      message: publicError(id, "本地服务未能启动"), buttons: ["导出诊断包", "关闭"], cancelId: 1 });
    if (choice.response === 0) await saveDiagnosticBundle(undefined, true)
      .catch(err => diagnostics.failure("diagnostic_export_failed", err));
    await stopManagedRuntime();
    app.quit();
    return false;
  }
}
