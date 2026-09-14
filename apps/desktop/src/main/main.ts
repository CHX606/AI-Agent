/** Electron composition root; product and transport depend on application ports. */
import { app } from "electron";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopServices } from "./application/ports.js";
import { GatewayClient } from "./infrastructure/gateway/gateway-client.js";
import { desktopDiagnostics, saveDiagnosticBundle } from "./infrastructure/observability/diagnostics.js";
import * as repository from "./infrastructure/persistence/repository.js";
import * as executionSettings from "./infrastructure/persistence/execution-settings.js";
import { createThemePreferences } from "./infrastructure/persistence/theme-preferences.js";
import * as runtime from "./infrastructure/runtime/managed-runtime.js";
import { startDesktop } from "./transport/electron.js";

if (process.env.BIT_AGENT_DESKTOP_USER_DATA) app.setPath("userData", process.env.BIT_AGENT_DESKTOP_USER_DATA);
const diagnostics = desktopDiagnostics();
const services: DesktopServices = {
  ...repository, ...executionSettings, ...runtime,
  ...createThemePreferences(app.getPath("userData")),
  diagnostics, saveDiagnosticBundle,
  gatewayClient: new GatewayClient(diagnostics, runtime.managedHeaders),
};
startDesktop(services, dirname(fileURLToPath(import.meta.url)));
