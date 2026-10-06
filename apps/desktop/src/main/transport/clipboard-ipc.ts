import { clipboard } from "electron";
import type { IpcHandler } from "./ipc-handler.js";

const MAX_COPY_LENGTH = 4 * 1024 * 1024;

/** 页面的 Clipboard API 在窗口没有焦点时会被拒绝；复制按钮改由主进程写入剪贴板。 */
export function registerClipboardIpc(handle: IpcHandler): void {
  handle("clipboard:write", (_event, text: unknown) => {
    if (typeof text !== "string" || text.length > MAX_COPY_LENGTH) throw new Error("复制的内容无效或过长");
    clipboard.writeText(text);
  });
}
