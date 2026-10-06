import { BrowserWindow, ipcMain, type WebContents } from "electron";
import type { DesktopServices } from "../application/ports.js";
import type { BrowserAction, BrowserBounds, BrowserPromptAnswer } from "../../shared/contracts.js";
import { BrowserPane } from "./browser-view.js";
import type { IpcHandler } from "./ipc-handler.js";

const ACTIONS = new Set<BrowserAction>(["back", "forward", "reload", "stop", "devtools", "external",
  "zoom-in", "zoom-out", "zoom-reset", "print"]);
const DOWNLOAD_ACTIONS = new Set(["open", "show", "cancel"] as const);
type DownloadAction = "open" | "show" | "cancel";

export function registerBrowserIpc(services: DesktopServices, handle: IpcHandler): void {
  const panes = new WeakMap<BrowserWindow, BrowserPane>();
  const pane = (sender: WebContents) => {
    const window = BrowserWindow.fromWebContents(sender);
    if (!window) throw new Error("窗口不存在");
    let existing = panes.get(window);
    if (!existing) {
      existing = new BrowserPane(window);
      panes.set(window, existing);
    }
    return existing;
  };
  const bounds = (value: unknown): BrowserBounds => {
    const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return { x: Number(input.x), y: Number(input.y), width: Number(input.width), height: Number(input.height) };
  };
  const text = (value: unknown, message: string) => {
    if (typeof value !== "string") throw new Error(message);
    return value;
  };

  handle("browser:state", (event) => pane(event.sender).state());
  handle("browser:show", (event, value: unknown, url: unknown) =>
    pane(event.sender).show(bounds(value), typeof url === "string" && url ? url : undefined));
  ipcMain.on("browser:bounds", (event, value: unknown) => { pane(event.sender).setBounds(bounds(value)); });
  handle("browser:hide", (event, snapshot: unknown) => pane(event.sender).hide(snapshot === true));
  handle("browser:navigate", (event, url: unknown) => pane(event.sender).navigate(text(url, "地址无效")));
  handle("browser:new-tab", (event, url: unknown, options: unknown) => {
    const value = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
    return pane(event.sender).newTab(typeof url === "string" && url ? url : undefined, {
      activate: value.activate !== false, lazy: value.lazy === true,
      ...(typeof value.title === "string" ? { title: value.title.slice(0, 300) } : {}),
    });
  });
  handle("browser:close-tab", (event, id: unknown) => pane(event.sender).close(text(id, "标签页无效")));
  handle("browser:select-tab", (event, id: unknown) => pane(event.sender).select(text(id, "标签页无效")));
  handle("browser:action", (event, action: unknown) => {
    if (!ACTIONS.has(action as BrowserAction)) throw new Error("不支持的操作");
    return pane(event.sender).action(action as BrowserAction);
  });
  handle("browser:download-action", (event, id: unknown, action: unknown) => {
    if (!DOWNLOAD_ACTIONS.has(action as DownloadAction)) throw new Error("不支持的操作");
    return pane(event.sender).downloadAction(text(id, "下载项无效"), action as DownloadAction);
  });
  handle("browser:prompt-answer", (event, id: unknown, answer: unknown) => {
    const value = (answer && typeof answer === "object" ? answer : {}) as Record<string, unknown>;
    const clean: BrowserPromptAnswer = typeof value.username === "string" && typeof value.password === "string"
      ? { username: value.username.slice(0, 500), password: value.password.slice(0, 500) }
      : typeof value.allow === "boolean" ? { allow: value.allow } : { cancel: true };
    pane(event.sender).answer(text(id, "请求无效"), clean);
  });
  handle("browser:trust-certificate", (event) => pane(event.sender).trustCertificate());
  handle("browser:find", (event, value: unknown, options: unknown) => {
    const input = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
    return pane(event.sender).find(typeof value === "string" ? value.slice(0, 500) : "",
      { forward: input.forward !== false, next: input.next === true });
  });
  ipcMain.on("browser:stop-find", (event) => { pane(event.sender).stopFind(); });
  handle("browser:local-servers", () => services.detectLocalServers());
}
