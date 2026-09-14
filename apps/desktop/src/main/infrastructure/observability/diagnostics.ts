import { app, dialog } from "electron";
import { join } from "node:path";
import { createDiagnostics, exportDiagnostics, type DiagnosticService } from "@bit-agent/diagnostics";

let service: DiagnosticService | undefined;
export function desktopDiagnostics(): DiagnosticService {
  if (!service) {
    const directory = process.env.BIT_AGENT_LOG_DIR ?? join(process.env.BIT_AGENT_DATA_DIR ??
      join(app.getPath("userData"), "runtime"), "logs");
    process.env.BIT_AGENT_LOG_DIR = directory;
    process.env.BIT_AGENT_VERSION = app.getVersion();
    service = createDiagnostics({ process: "electron", directory, version: app.getVersion() });
  }
  return service;
}

export async function saveDiagnosticBundle(snapshot?: unknown, unavailable = false) {
  const selected = await dialog.showSaveDialog({ title: "导出脱敏诊断包",
    defaultPath: `BitAgent-diagnostics-${new Date().toISOString().replace(/[:.]/gu, "-")}.zip`,
    filters: [{ name: "诊断包", extensions: ["zip"] }],
  });
  if (selected.canceled || !selected.filePath) return { cancelled: true };
  const diagnostics = desktopDiagnostics();
  await diagnostics.flush();
  return exportDiagnostics({ directory: diagnostics.directory, destination: selected.filePath,
    version: app.getVersion(), snapshot, unavailable });
}
