import { ipcMain } from "electron";
import { publicError, type DiagnosticService } from "@bit-agent/diagnostics";
import { isUserFacing } from "../application/errors.js";

export type IpcHandler = (channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) => void;

export function createIpcHandler(diagnostics: DiagnosticService): IpcHandler {
  return (channel, listener) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try { return await listener(event, ...args); }
      catch (error) {
        // 运行服务明确写给用户的说明（已带诊断编号）原样交给页面，其余只给通用提示。
        if (isUserFacing(error)) throw new Error(error.message);
        const id = diagnostics.failure("ipc_failed", error, { operation: channel });
        throw new Error(publicError(id));
      }
    });
  };
}
