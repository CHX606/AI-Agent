import { BrowserWindow } from "electron";
import { BrowserPane } from "./browser-view.js";

// 每个窗口一个内置浏览器；页面（IPC）和 Agent（MCP 服务）用的是同一个。
const panes = new WeakMap<BrowserWindow, BrowserPane>();

export function browserPaneFor(window: BrowserWindow): BrowserPane {
  let pane = panes.get(window);
  if (!pane) {
    pane = new BrowserPane(window);
    panes.set(window, pane);
  }
  return pane;
}

/** Agent 用的浏览器：应用的主窗口（第一个窗口）。 */
export function mainBrowserPane(): BrowserPane | null {
  const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
  return window ? browserPaneFor(window) : null;
}
