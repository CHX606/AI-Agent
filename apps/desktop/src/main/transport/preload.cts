import { contextBridge, ipcRenderer } from "electron";

import type { ColorTheme, DesktopApi, TaskEvent, TerminalExit, TerminalOutput } from "../../shared/contracts.js";

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
  gitStatus: (input) => ipcRenderer.invoke("git:status", input),
  suggestCommitMessage: (input) => ipcRenderer.invoke("git:message", input),
  commitChanges: (input) => ipcRenderer.invoke("git:commit", input),
  getModelSettings: () => ipcRenderer.invoke("model:get"),
  saveModelSettings: (input) => ipcRenderer.invoke("model:save", input),
  testModelSettings: (input) => ipcRenderer.invoke("model:test", input),
  listModels: (input) => ipcRenderer.invoke("model:list", input),
  listMcpServers: () => ipcRenderer.invoke("mcp:list"),
  saveMcpServers: (input) => ipcRenderer.invoke("mcp:save", input),
  testMcpServer: (input) => ipcRenderer.invoke("mcp:test", input),
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
  listSessions: (gatewayUrl, offset, query) => ipcRenderer.invoke("sessions:list", gatewayUrl, offset, query),
  renameSession: (input) => ipcRenderer.invoke("sessions:rename", input),
  deleteSession: (input) => ipcRenderer.invoke("sessions:delete", input),
  rewindTurn: (input) => ipcRenderer.invoke("sessions:rewind", input),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  getSession: (input) => ipcRenderer.invoke("sessions:get", input),
  setSessionMode: (input) => ipcRenderer.invoke("sessions:mode", input),
  listMemories: (input) => ipcRenderer.invoke("memories:list", input),
  deleteMemory: (input) => ipcRenderer.invoke("memories:delete", input),
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
  openTerminal: (input) => ipcRenderer.invoke("terminal:open", input),
  writeTerminal: (id, data) => ipcRenderer.send("terminal:write", id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send("terminal:resize", id, cols, rows),
  closeTerminal: (id) => ipcRenderer.invoke("terminal:close", id),
  onTerminalOutput: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalOutput) => listener(payload);
    ipcRenderer.on("terminal:output", handler);
    return () => ipcRenderer.removeListener("terminal:output", handler);
  },
  onTerminalExit: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalExit) => listener(payload);
    ipcRenderer.on("terminal:exit", handler);
    return () => ipcRenderer.removeListener("terminal:exit", handler);
  },
};

contextBridge.exposeInMainWorld("bitAgent", api);
