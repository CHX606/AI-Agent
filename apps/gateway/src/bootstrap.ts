/** Composition root: only this boundary selects default concrete adapters. */
import { MemoryTaskStore } from "./infrastructure/persistence/memory-task-store.js";
import { gatewayDiagnostics } from "./infrastructure/observability/diagnostics.js";
import { createHttpApp, type BuildAppOptions } from "./transport/http/app.js";

export function buildApp(options: Partial<BuildAppOptions> = {}) {
  return createHttpApp({
    ...options,
    taskStore: options.taskStore ?? new MemoryTaskStore(),
    diagnostics: options.diagnostics ?? gatewayDiagnostics,
  });
}
