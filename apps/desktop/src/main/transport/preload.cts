import { contextBridge, ipcRenderer } from "electron";

import type { ColorTheme, DesktopApi, TaskEvent } from "../../shared/contracts.js";

const rawTheme: unknown = ipcRenderer.sendSync("theme:get");
const colorTheme: ColorTheme = rawTheme === "dark" ? "dark" : "light";

const api: DesktopApi = {
  reportClientError: (input) => ipcRenderer.invoke("diagnostics:renderer-error", input),
  diagnosticStatus: (input) => ipcRenderer.invoke("diagnostics:status", input),
  exportDiagnostics: (input) => ipcRenderer.invoke("diagnostics:export", input),
  colorTheme,
  runtimeConfig: ipcRenderer.sendSync("desktop:config"),
  getChanges: (input) => ipcRenderer.invoke("changes:get", input),
  reviewChange: (input) => ipcRenderer.invoke("changes:review", input),
  getModelSettings: () => ipcRenderer.invoke("model:get"),
  saveModelSettings: (input) => ipcRenderer.invoke("model:save", input),
  getExecutionSettings: () => ipcRenderer.invoke("execution:get"),
  saveExecutionSettings: (input) => ipcRenderer.invoke("execution:save", input),
  setTheme: (theme) => ipcRenderer.send("theme:set", theme),
  selectWorkspace: () => ipcRenderer.invoke("workspace:select") as Promise<string | null>,
  setRepositoryWorkspace: (workspaceRoot) =>
    ipcRenderer.invoke("repository:set-workspace", workspaceRoot) as Promise<string>,
  listRepositoryDirectory: (input) => ipcRenderer.invoke("repository:list", input),
  readRepositoryFile: (input) => ipcRenderer.invoke("repository:read", input),
  health: (gatewayUrl) => ipcRenderer.invoke("gateway:health", gatewayUrl) as Promise<unknown>,
  createTask: (input) => ipcRenderer.invoke("tasks:create", input),
  listSessions: (gatewayUrl, offset) => ipcRenderer.invoke("sessions:list", gatewayUrl, offset),
  getSession: (input) => ipcRenderer.invoke("sessions:get", input),
  setSessionMode: (input) => ipcRenderer.invoke("sessions:mode", input),
  getTask: (input) => ipcRenderer.invoke("tasks:get", input),
  getResult: (input) => ipcRenderer.invoke("tasks:result", input),
  cancelTask: (input) => ipcRenderer.invoke("tasks:cancel", input),
  interactTask: (input) => ipcRenderer.invoke("tasks:interact", input),
  watchTask: (input) => ipcRenderer.send("tasks:watch", input),
  unwatchTask: (taskId) => ipcRenderer.send("tasks:unwatch", taskId),
  onTaskEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TaskEvent) => listener(payload);
    ipcRenderer.on("task:event", handler);
    return () => ipcRenderer.removeListener("task:event", handler);
  },
};

contextBridge.exposeInMainWorld("bitAgent", api);
