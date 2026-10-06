import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  views: [] as any[], captureDelay: 0, opened: [] as string[], menus: [] as any[][], session: null as any,
}));
vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  let nextId = 1;
  class Contents extends Emitter {
    id = nextId++;
    url = "";
    zoom = 1;
    loaded: string[] = [];
    finds: unknown[][] = [];
    stopped: string[] = [];
    windowOpen: ((details: { url: string; disposition?: string }) => { action: string }) | null = null;
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    isDestroyed() { return false; }
    close() {}
    getURL() { return this.url; }
    getTitle() { return this.url ? `title of ${this.url}` : ""; }
    isLoading() { return false; }
    getZoomFactor() { return this.zoom; }
    setZoomFactor(value: number) { this.zoom = value; }
    loadURL(url: string) { this.loaded.push(url); this.url = url; return Promise.resolve(); }
    setWindowOpenHandler(handler: any) { this.windowOpen = handler; }
    findInPage(...args: unknown[]) { this.finds.push(args); return this.finds.length; }
    stopFindInPage(action: string) { this.stopped.push(action); }
    capturePage() {
      return new Promise((resolve) => setTimeout(() => resolve({ isEmpty: () => false, toJPEG: () => Buffer.from("jpg") }), fake.captureDelay));
    }
  }
  class WebContentsView {
    webContents = new Contents();
    visible = false;
    constructor() { fake.views.push(this); }
    setBackgroundColor() {}
    setVisible(value: boolean) { this.visible = value; }
    getVisible() { return this.visible; }
    setBounds() {}
  }
  const session = Object.assign(new Emitter(), {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, getUserAgent: () => "UA", setUserAgent() {},
  });
  fake.session = session;
  return {
    WebContentsView, session: { fromPartition: () => session },
    app: { getPath: () => "C:\\Users\\me\\Downloads" },
    clipboard: { writeText: vi.fn() },
    Menu: { buildFromTemplate: (items: any[]) => { fake.menus.push(items); return { popup() {} }; } },
    shell: { openExternal: async (url: string) => { fake.opened.push(`external:${url}`); },
      openPath: async (path: string) => { fake.opened.push(`open:${path}`); return ""; },
      showItemInFolder: (path: string) => { fake.opened.push(`show:${path}`); } },
  };
});

import { BrowserPane, isExecutable, nextZoom, uniquePath } from "../src/main/transport/browser-view";

function fakeWindow(visible = true) {
  const window = Object.assign(new EventEmitter(), {
    contentView: { addChildView() {}, removeChildView() {} }, webContents: Object.assign(new EventEmitter(), { send: vi.fn(), focus() {} }),
    getContentSize: () => [1200, 800], isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false,
  });
  return window as any;
}
const lastContents = () => fake.views.at(-1).webContents;
const bounds = { x: 0, y: 0, width: 100, height: 100 };

beforeEach(() => { fake.views.length = 0; fake.captureDelay = 0; fake.opened.length = 0; fake.menus.length = 0; });

it("matches find results by request and waits for the final update", async () => {
  const pane = new BrowserPane(fakeWindow());
  await pane.show(bounds, "https://example.com/");
  const contents = lastContents();
  const pending = pane.find("needle", { next: true, forward: false });
  expect(contents.finds.at(-1)).toEqual(["needle", { forward: false, findNext: true }]);
  contents.emit("found-in-page", {}, { requestId: 99, matches: 7, activeMatchOrdinal: 1, finalUpdate: true });
  contents.emit("found-in-page", {}, { requestId: 1, matches: 2, activeMatchOrdinal: 1, finalUpdate: false });
  contents.emit("found-in-page", {}, { requestId: 1, matches: 2, activeMatchOrdinal: 2, finalUpdate: true });
  expect(await pending).toEqual({ matches: 2, active: 2 });
  expect(await pane.find("", {})).toEqual({ matches: 0, active: 0 });
  expect(contents.stopped).toEqual(["clearSelection"]);
});

it("gives up on find after a timeout instead of hanging", async () => {
  vi.useFakeTimers();
  try {
    const pane = new BrowserPane(fakeWindow());
    await pane.show(bounds, "https://example.com/");
    const pending = pane.find("needle", {});
    await vi.advanceTimersByTimeAsync(2100);
    expect(await pending).toEqual({ matches: 0, active: 0 });
  } finally { vi.useRealTimers(); }
});

it("only snapshots a visible window and does not wait long for the picture", async () => {
  const hidden = new BrowserPane(fakeWindow(false));
  await hidden.show(bounds, "https://example.com/");
  expect(await hidden.hide(true)).toBeNull();

  const visible = new BrowserPane(fakeWindow(true));
  await visible.show(bounds, "https://example.com/");
  expect(await visible.hide(true)).toBe(`data:image/jpeg;base64,${Buffer.from("jpg").toString("base64")}`);
  await visible.show(bounds);
  fake.captureDelay = 5000;
  const started = Date.now();
  expect(await visible.hide(true)).toBeNull();
  expect(Date.now() - started).toBeLessThan(1500);
});

it("keeps navigation to http(s) and opens new windows as tabs", async () => {
  const pane = new BrowserPane(fakeWindow());
  await pane.show(bounds, "https://example.com/");
  const contents = lastContents();
  await expect(pane.navigate("file:///C:/secret.txt")).rejects.toThrow("只能打开 http 或 https 地址");
  const blocked = { preventDefault: vi.fn() };
  contents.emit("will-navigate", blocked, "javascript:alert(1)");
  expect(blocked.preventDefault).toHaveBeenCalled();
  const allowed = { preventDefault: vi.fn() };
  contents.emit("will-navigate", allowed, "https://example.com/next");
  expect(allowed.preventDefault).not.toHaveBeenCalled();

  expect(contents.windowOpen({ url: "https://example.com/popup", disposition: "foreground-tab" })).toEqual({ action: "deny" });
  let state = pane.state();
  expect(state.tabs.map((tab) => tab.url)).toEqual(["https://example.com/", "https://example.com/popup"]);
  expect(state.activeId).toBe(state.tabs[1]!.id);
  contents.windowOpen({ url: "https://example.com/background", disposition: "background-tab" });
  state = pane.state();
  expect(state.tabs).toHaveLength(3);
  expect(state.activeId).toBe(state.tabs[1]!.id);
  contents.windowOpen({ url: "file:///C:/x", disposition: "foreground-tab" });
  expect(pane.state().tabs).toHaveLength(3);
});

it("loads restored tabs only when selected and picks the right neighbour after closing", async () => {
  const pane = new BrowserPane(fakeWindow());
  await pane.show(bounds);
  const a = pane.newTab("https://a.test/", { lazy: true, title: "A" });
  const b = pane.newTab("https://b.test/", { lazy: true, title: "B", activate: false });
  const c = pane.newTab("https://c.test/", { activate: false });
  const [viewA, viewB, viewC] = fake.views;
  expect(viewA.webContents.loaded).toEqual(["https://a.test/"]);
  expect(viewB.webContents.loaded).toEqual([]);
  expect(viewC.webContents.loaded).toEqual(["https://c.test/"]);
  expect(pane.state().tabs.map((tab) => tab.title)).toEqual(["title of https://a.test/", "B", "title of https://c.test/"]);
  expect([viewA.visible, viewB.visible, viewC.visible]).toEqual([true, false, false]);
  pane.select(b);
  expect(viewB.webContents.loaded).toEqual(["https://b.test/"]);
  expect([viewA.visible, viewB.visible, viewC.visible]).toEqual([false, true, false]);
  pane.close(b);
  expect(pane.state().activeId).toBe(c);
  pane.close(c);
  expect(pane.state().activeId).toBe(a);
  pane.close(a);
  expect(pane.state()).toMatchObject({ tabs: [], activeId: null, url: "" });
});

it("hides the page views when the app page reloads", async () => {
  const window = fakeWindow();
  const pane = new BrowserPane(window);
  await pane.show(bounds, "https://example.com/");
  expect(fake.views[0].visible).toBe(true);
  window.webContents.emit("did-start-loading");
  expect(fake.views[0].visible).toBe(false);
  expect(pane.state().tabs).toHaveLength(1);
});

it("steps zoom through fixed levels", async () => {
  expect(nextZoom(1, "in")).toBe(1.1);
  expect(nextZoom(1, "out")).toBe(0.9);
  expect(nextZoom(3, "in")).toBe(3);
  expect(nextZoom(0.25, "out")).toBe(0.25);
  const pane = new BrowserPane(fakeWindow());
  await pane.show(bounds, "https://example.com/");
  await pane.action("zoom-in");
  await pane.action("zoom-in");
  expect(pane.state().zoom).toBe(1.25);
  lastContents().emit("zoom-changed", {}, "out");
  expect(pane.state().zoom).toBe(1.1);
  await pane.action("zoom-reset");
  expect(pane.state().zoom).toBe(1);
});

it("names downloads uniquely and never runs executables from the app", async () => {
  const taken = new Set(["C:\\d\\report.pdf", "C:\\d\\report (1).pdf"]);
  expect(uniquePath("C:\\d", "report.pdf", (path) => taken.has(path))).toBe("C:\\d\\report (2).pdf");
  expect(uniquePath("C:\\d", "..\\..\\evil:name?.txt", () => false)).toBe("C:\\d\\evil_name_.txt");
  expect(isExecutable("setup.EXE")).toBe(true);
  expect(isExecutable("notes.txt")).toBe(false);

  const window = fakeWindow();
  const pane = new BrowserPane(window);
  await pane.show(bounds, "https://example.com/");
  const item = Object.assign(new EventEmitter(), {
    path: "", state: "progressing",
    getFilename: () => "setup.exe", setSavePath(path: string) { this.path = path; }, getSavePath() { return this.path; },
    getReceivedBytes: () => 10, getTotalBytes: () => 20, getState() { return this.state; }, cancel: vi.fn(),
  });
  fake.session.emit("will-download", {}, item, lastContents());
  const sent = () => window.webContents.send.mock.calls.filter(([channel]: [string]) => channel === "browser:download").map(([, value]: [string, any]) => value);
  expect(sent()[0]).toMatchObject({ filename: "setup.exe", state: "progressing", executable: true, received: 10, total: 20 });
  item.state = "completed";
  item.emit("done", {}, "completed");
  const { id } = sent().at(-1);
  await pane.downloadAction(id, "open");
  expect(fake.opened).toEqual([]);
  await pane.downloadAction(id, "show");
  expect(fake.opened).toEqual([`show:${item.path}`]);
});

it("builds a context menu that fits what was clicked", async () => {
  const pane = new BrowserPane(fakeWindow());
  await pane.show(bounds, "https://example.com/");
  const contents = lastContents();
  const base = { x: 1, y: 2, linkURL: "", srcURL: "", mediaType: "none", isEditable: false, selectionText: "",
    editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } };
  const labels = () => fake.menus.at(-1)!.filter((item) => item.label).map((item) => item.label);
  contents.emit("context-menu", {}, { ...base, linkURL: "https://example.com/next" });
  expect(labels()).toEqual(["在新标签页中打开链接", "在系统浏览器中打开链接", "复制链接地址", "检查元素"]);
  fake.menus.at(-1)!.find((item) => item.label === "在新标签页中打开链接").click();
  expect(pane.state().tabs.at(-1)!.url).toBe("https://example.com/next");
  const selection = "一段很长很长很长很长很长很长很长的选中文字";
  contents.emit("context-menu", {}, { ...base, selectionText: selection });
  expect(labels().slice(0, 2)).toEqual(["复制", `搜索“${selection.slice(0, 18)}…”`]);
  contents.emit("context-menu", {}, { ...base, isEditable: true });
  expect(labels()).toEqual(["撤销", "重做", "剪切", "复制", "粘贴", "全选", "检查元素"]);
  contents.emit("context-menu", {}, base);
  expect(labels()).toEqual(["后退", "前进", "重新加载", "打印…", "检查元素"]);
});
