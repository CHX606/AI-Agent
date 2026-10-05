import { app, ipcMain } from "electron";
import type { DesktopServices } from "../application/ports.js";
import type { IpcHandler } from "./ipc-handler.js";

export function registerSettingsIpc(services: DesktopServices, handle: IpcHandler): void {
  const { runtimeConfiguration, modelSettings, saveModelSettings, testModelSettings,
    listProviderModels, mcpServers, saveMcpServers, testMcpServer,
    readExecutionSettings, writeExecutionSettings } = services;
  ipcMain.on("desktop:config", (event) => { event.returnValue = runtimeConfiguration(); });
  handle("model:get", () => modelSettings());
  handle("model:save", (_event, input: unknown) => saveModelSettings(input));
  handle("model:test", (_event, input: unknown) => testModelSettings(input));
  handle("model:list", (_event, input: unknown) => listProviderModels(input));
  handle("mcp:list", () => mcpServers());
  handle("mcp:save", (_event, input: unknown) => saveMcpServers(input));
  handle("mcp:test", (_event, input: unknown) => testMcpServer(input));
  handle("execution:get", () => readExecutionSettings(app.getPath("userData")));
  handle("execution:save", (_event, input: unknown) => writeExecutionSettings(app.getPath("userData"), input));
}
