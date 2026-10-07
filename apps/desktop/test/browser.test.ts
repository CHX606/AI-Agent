import { expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  on: new Map<string, (...args: any[]) => void>(),
  handle: new Map<string, (...args: any[]) => unknown>(),
  window: {} as Record<string, unknown>,
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => electron.window },
  ipcMain: { on: (channel: string, listener: (...args: any[]) => void) => electron.on.set(channel, listener) },
  session: {}, shell: {}, WebContentsView: class {}, app: {}, clipboard: {}, Menu: {},
}));
const pane = vi.hoisted(() => ({
  show: vi.fn(async () => ({})), setBounds: vi.fn(), hide: vi.fn(async () => null), navigate: vi.fn(async () => {}),
  action: vi.fn(async () => {}), find: vi.fn(async () => ({ matches: 0, active: 0 })), stopFind: vi.fn(),
}));
vi.mock("../src/main/transport/browser-view", async (original) => ({
  ...(await original<typeof import("../src/main/transport/browser-view")>()),
  BrowserPane: class { constructor() { return pane; } },
}));

import { browserAddress, displayAddress, isBrowsableUrl, SEARCH_URL } from "../src/shared/browser-address";
import { browserErrorMessage } from "../src/shared/browser-errors";
import { browserUserAgent, shortcutFor } from "../src/main/transport/browser-view";
import { registerBrowserIpc } from "../src/main/transport/browser-ipc";

it("turns address bar input into http(s) addresses or a search", () => {
  expect(browserAddress("  ")).toBeNull();
  expect(browserAddress("localhost:5173")).toBe("http://localhost:5173/");
  expect(browserAddress("127.0.0.1:8000/docs")).toBe("http://127.0.0.1:8000/docs");
  expect(browserAddress("app.localhost")).toBe("http://app.localhost/");
  expect(browserAddress("192.168.1.20:3000")).toBe("http://192.168.1.20:3000/");
  expect(browserAddress("developers.openai.com/api")).toBe("https://developers.openai.com/api");
  expect(browserAddress("https://example.com")).toBe("https://example.com/");
  expect(browserAddress("vite 配置")).toBe(`${SEARCH_URL}${encodeURIComponent("vite 配置")}`);
  expect(browserAddress("react")).toBe(`${SEARCH_URL}react`);
  for (const blocked of ["file:///C:/secret.txt", "javascript:alert(1)", "data:text/html,x", "ftp://example.com"]) {
    expect(() => browserAddress(blocked)).toThrow("只能打开 http 或 https 地址");
  }
  expect(isBrowsableUrl("chrome://settings")).toBe(false);
});

it("explains common load errors in plain words", () => {
  expect(browserErrorMessage(-102, "ERR_CONNECTION_REFUSED")).toContain("没有正在运行的服务");
  expect(browserErrorMessage(-105, "ERR_NAME_NOT_RESOLVED")).toContain("找不到这个网站");
  expect(browserErrorMessage(-215, "ERR_CERT_SOMETHING")).toBe("网站的安全证书有问题，已阻止访问。");
  expect(browserErrorMessage(-999, "ERR_UNKNOWN")).toBe("ERR_UNKNOWN");
});

it("shows a short address and the search words for searches", () => {
  expect(displayAddress("https://example.com/")).toBe("example.com");
  expect(displayAddress("http://localhost:5173/app/")).toBe("localhost:5173/app/");
  expect(displayAddress(`${SEARCH_URL}${encodeURIComponent("vite 配置")}`)).toBe("vite 配置");
});

it("removes Electron and the app name from the user agent", () => {
  expect(browserUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) bit-agent/1.0.0 Chrome/140.0.0.0 Electron/44.1.1 Safari/537.36"))
    .toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
});

it("keeps app shortcuts working while the page has focus", () => {
  const key = (key: string, extra: Partial<Electron.Input> = {}) =>
    shortcutFor({ type: "keyDown", key, code: "", control: false, meta: false, alt: false, shift: false, ...extra });
  expect(key("l", { control: true })).toBe("focus-address");
  expect(key("f", { control: true })).toBe("find");
  expect(key("b", { control: true })).toBe("toggle-sidebar");
  expect(key("`", { control: true, code: "Backquote" })).toBe("toggle-terminal");
  expect(key("F5")).toBe("reload");
  expect(key("r", { control: true, shift: true })).toBe("hard-reload");
  expect(key("ArrowLeft", { alt: true })).toBe("back");
  expect(key("F12")).toBe("devtools");
  expect(key("t", { control: true })).toBe("new-tab");
  expect(key("w", { control: true })).toBe("close-tab");
  expect(key("Tab", { control: true })).toBe("next-tab");
  expect(key("Tab", { control: true, shift: true })).toBe("previous-tab");
  expect(key("=", { control: true })).toBe("zoom-in");
  expect(key("-", { control: true })).toBe("zoom-out");
  expect(key("0", { control: true })).toBe("zoom-reset");
  expect(key("p", { control: true })).toBe("print");
  expect(key("c", { control: true })).toBeNull();
  expect(key("a")).toBeNull();
  expect(shortcutFor({ type: "keyUp", key: "l", code: "", control: true, meta: false, alt: false, shift: false })).toBeNull();
});

it("validates browser IPC input before reaching the view", async () => {
  // 和真实的 ipcMain.handle 一样，同步抛出的错误变成被拒绝的 Promise。
  registerBrowserIpc(
    (channel, listener) => electron.handle.set(channel, async (...args: any[]) => listener(...(args as [any])) ));
  const event = { sender: {} };
  await electron.handle.get("browser:show")!(event, { x: 10, y: 20, width: 300, height: 200 }, "");
  expect(pane.show).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 300, height: 200 }, undefined);
  await expect(electron.handle.get("browser:navigate")!(event, 42)).rejects.toThrow("地址无效");
  await expect(electron.handle.get("browser:action")!(event, "format-disk")).rejects.toThrow("不支持的操作");
  await expect(electron.handle.get("browser:download-action")!(event, "id", "run")).rejects.toThrow("不支持的操作");
  await expect(electron.handle.get("browser:close-tab")!(event, 7)).rejects.toThrow("标签页无效");
  await electron.handle.get("browser:action")!(event, "back");
  expect(pane.action).toHaveBeenLastCalledWith("back");
  await electron.handle.get("browser:find")!(event, "x".repeat(900), { forward: false, next: true });
  expect(pane.find).toHaveBeenLastCalledWith("x".repeat(500), { forward: false, next: true });
  await electron.handle.get("browser:hide")!(event, "yes");
  expect(pane.hide).toHaveBeenLastCalledWith(false);
});
