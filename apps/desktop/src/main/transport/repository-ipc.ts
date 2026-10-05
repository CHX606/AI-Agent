import { dialog } from "electron";
import type { DesktopServices } from "../application/ports.js";
import type { IpcHandler } from "./ipc-handler.js";

export function registerRepositoryIpc(services: DesktopServices, handle: IpcHandler): void {
  const roots = new Map<number, string>();
  registerWorkspaceSelection(services, handle, roots);
  registerDirectoryAccess(services, handle, roots);
  registerFileAccess(services, handle, roots);
}

function registerWorkspaceSelection(services: DesktopServices,
  handle: IpcHandler, roots: Map<number, string>): void {
  const { validateRepositoryWorkspace } = services;
  handle("workspace:select", async (event) => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    const selectedPath = result.canceled ? null : (result.filePaths[0] ?? null);
    if (selectedPath) roots.set(event.sender.id, await validateRepositoryWorkspace(selectedPath));
    return selectedPath;
  });
  handle("repository:set-workspace", async (event, workspaceRoot: unknown) => {
    if (typeof workspaceRoot !== "string") throw new Error("工作区路径无效");
    const canonicalRoot = await validateRepositoryWorkspace(workspaceRoot);
    roots.set(event.sender.id, canonicalRoot);
    return canonicalRoot;
  });
}

function registerDirectoryAccess(services: DesktopServices,
  handle: IpcHandler, roots: Map<number, string>): void {
  const { listRepositoryDirectory } = services;
  handle("repository:list", (event, input: unknown) => {
    if (!input || typeof input !== "object" || !("path" in input)) throw new Error("目录参数无效");
    const path = (input as { path?: unknown }).path;
    if (typeof path !== "string") throw new Error("目录路径无效");
    const workspaceRoot = roots.get(event.sender.id);
    if (!workspaceRoot) throw new Error("请先选择工作区");
    return listRepositoryDirectory({ workspaceRoot, path });
  });
}

function registerFileAccess(services: DesktopServices,
  handle: IpcHandler, roots: Map<number, string>): void {
  const { readRepositoryFile } = services;
  handle("repository:read", (event, input: unknown) => {
    if (!input || typeof input !== "object" || !("path" in input)) throw new Error("文件参数无效");
    const path = (input as { path?: unknown }).path;
    if (typeof path !== "string") throw new Error("文件路径无效");
    const workspaceRoot = roots.get(event.sender.id);
    if (!workspaceRoot) throw new Error("请先选择工作区");
    return readRepositoryFile({ workspaceRoot, path });
  });
}
