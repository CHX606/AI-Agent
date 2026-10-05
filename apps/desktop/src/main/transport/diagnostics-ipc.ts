import { publicError } from "@bit-agent/diagnostics";
import type { DesktopServices } from "../application/ports.js";
import type { IpcHandler } from "./ipc-handler.js";

interface DiagnosticsInput { gatewayUrl?: string; taskId?: string }

async function diagnosticSnapshot(services: DesktopServices, input: DiagnosticsInput):
  Promise<{ snapshot: Record<string, unknown>; unavailable: boolean }> {
  const { runtimeConfiguration } = services;
  const requestJson = services.gatewayClient.request.bind(services.gatewayClient);
  let snapshot: Record<string, unknown> = {};
  let unavailable = false;
  try { snapshot = await requestJson(input.gatewayUrl || runtimeConfiguration().gatewayUrl,
    `/v1/diagnostics${input.taskId ? `?task_id=${encodeURIComponent(input.taskId)}` : ""}`); }
  catch { unavailable = true; }
  return { snapshot, unavailable };
}

export function registerDiagnosticsIpc(services: DesktopServices, handle: IpcHandler): void {
  const { diagnostics, saveDiagnosticBundle } = services;
  handle("diagnostics:renderer-error", (_event, input: { kind?: string; taskId?: string; line?: number }) => {
    const id = diagnostics.failure("renderer_unhandled", new Error(), {
      reason: input.kind === "rejection" ? "rejection" : "exception", task_id: input.taskId,
      sequence: typeof input.line === "number" ? input.line : undefined,
    });
    return publicError(id, "界面遇到异常，请重新打开应用");
  });
  handle("diagnostics:status", async (_event, input: DiagnosticsInput) => {
    const { snapshot, unavailable } = await diagnosticSnapshot(services, input);
    return { ...snapshot, directory: diagnostics.directory,
      available: diagnostics.available() && snapshot.available !== false, unavailable };
  });
  handle("diagnostics:export", async (_event, input: DiagnosticsInput) => {
    const { snapshot, unavailable } = await diagnosticSnapshot(services, input);
    return saveDiagnosticBundle(snapshot, unavailable);
  });
}
