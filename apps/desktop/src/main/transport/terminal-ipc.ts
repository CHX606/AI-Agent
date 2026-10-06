import { app, ipcMain, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type { DesktopServices, TerminalProcess } from "../application/ports.js";
import type { TerminalInfo } from "../../shared/contracts.js";
import type { IpcHandler } from "./ipc-handler.js";

const MAX_TERMINALS_PER_WINDOW = 8;
const MAX_INPUT = 64 * 1024;
// 输出先攒几毫秒再发给页面，避免大量输出时每个字节一条 IPC 消息。
const FLUSH_DELAY_MS = 8;

interface OpenTerminal {
  owner: WebContents;
  process: TerminalProcess;
  pending: string;
  timer: NodeJS.Timeout | null;
}

function size(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
}

export function registerTerminalIpc(services: DesktopServices, handle: IpcHandler): void {
  const terminals = new Map<string, OpenTerminal>();
  // 窗口关闭时结束它打开的所有终端；每个窗口只登记一次。
  const watchedOwners = new WeakSet<WebContents>();
  const owned = (sender: WebContents, id: unknown) => {
    const terminal = typeof id === "string" ? terminals.get(id) : undefined;
    return terminal && terminal.owner === sender ? terminal : undefined;
  };
  const flush = (id: string, terminal: OpenTerminal) => {
    terminal.timer = null;
    if (!terminal.pending || terminal.owner.isDestroyed()) return;
    terminal.owner.send("terminal:output", { id, data: terminal.pending });
    terminal.pending = "";
  };
  const close = (id: string) => {
    const terminal = terminals.get(id);
    if (!terminal) return;
    terminals.delete(id);
    if (terminal.timer) clearTimeout(terminal.timer);
    terminal.process.kill();
  };

  handle("terminal:open", async (event, input: unknown): Promise<TerminalInfo> => {
    const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const owner = event.sender;
    if ([...terminals.values()].filter((terminal) => terminal.owner === owner).length >= MAX_TERMINALS_PER_WINDOW) {
      throw new Error(`最多同时打开 ${MAX_TERMINALS_PER_WINDOW} 个终端`);
    }
    const root = typeof value.workspaceRoot === "string" ? value.workspaceRoot.trim() : "";
    const cwd = root ? await services.validateRepositoryWorkspace(root) : "";
    const child = services.spawnTerminal({ cwd, cols: size(value.cols, 2, 500, 80), rows: size(value.rows, 2, 200, 24) });
    const id = randomUUID();
    const terminal: OpenTerminal = { owner, process: child, pending: "", timer: null };
    terminals.set(id, terminal);
    child.onData((data) => {
      terminal.pending += data;
      terminal.timer ??= setTimeout(() => flush(id, terminal), FLUSH_DELAY_MS);
    });
    child.onExit((exitCode) => {
      if (terminal.timer) clearTimeout(terminal.timer);
      flush(id, terminal);
      terminals.delete(id);
      if (!owner.isDestroyed()) owner.send("terminal:exit", { id, exitCode });
    });
    if (!watchedOwners.has(owner)) {
      watchedOwners.add(owner);
      owner.once("destroyed", () => {
        for (const [key, other] of terminals) if (other.owner === owner) close(key);
      });
    }
    return { id, shell: child.shell, cwd: child.cwd };
  });
  ipcMain.on("terminal:write", (event, id: unknown, data: unknown) => {
    if (typeof data === "string" && data.length <= MAX_INPUT) owned(event.sender, id)?.process.write(data);
  });
  ipcMain.on("terminal:resize", (event, id: unknown, cols: unknown, rows: unknown) => {
    owned(event.sender, id)?.process.resize(size(cols, 2, 500, 80), size(rows, 2, 200, 24));
  });
  handle("terminal:close", (event, id: unknown) => {
    if (owned(event.sender, id)) close(id as string);
  });
  app.on("before-quit", () => { for (const id of [...terminals.keys()]) close(id); });
}
