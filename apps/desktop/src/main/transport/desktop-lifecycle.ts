import { app, dialog } from "electron";
import { diagnosticId, errorFields, publicError, installProcessDiagnostics } from "@bit-agent/diagnostics";
import type { DesktopServices } from "../application/ports.js";

export function installDesktopDiagnostics(services: DesktopServices): void {
  const { diagnostics, stopManagedRuntime } = services;
  installProcessDiagnostics(diagnostics);
  diagnostics.record("info", "desktop_starting");
  let fatalHandled = false;
  const handleFatal = (error: unknown): void => {
    if (fatalHandled) return;
    fatalHandled = true;
    const id = diagnosticId(error);
    diagnostics.record("fatal", "desktop_unhandled", { ...errorFields(error), diagnostic_id: id });
    if (app.isReady()) dialog.showErrorBox("应用遇到异常", publicError(id, "请重新启动应用，已保存的记录会保留"));
    void stopManagedRuntime().finally(() => app.exit(1));
  };
  process.on("uncaughtException", handleFatal);
  process.on("unhandledRejection", handleFatal);
}

export function registerDesktopLifecycle(services: DesktopServices, stopWatches: () => void): void {
  const { diagnostics, stopManagedRuntime } = services;
  app.on("window-all-closed", () => {
    stopWatches();
    if (process.platform !== "darwin") app.quit();
  });
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stopWatches();
    void stopManagedRuntime().finally(async () => { await diagnostics.close(); app.exit(0); });
  });
  app.on("child-process-gone", (_event, details) => diagnostics.failure("electron_child_gone", new Error(), {
    reason: details.reason, exit_code: details.exitCode, process: "electron", operation: details.type,
  }));
}
