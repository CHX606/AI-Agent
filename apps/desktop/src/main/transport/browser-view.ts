import { app, clipboard, Menu, session, shell, WebContentsView, type BrowserWindow, type Session } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { isBrowsableUrl, SEARCH_URL } from "../../shared/browser-address.js";
import type { BrowserAction, BrowserBounds, BrowserDownload, BrowserShortcut, BrowserState, BrowserTab } from "../../shared/contracts.js";

/** 内置浏览器用独立的持久会话：Cookie、缓存和应用自己的页面分开。 */
export const BROWSER_PARTITION = "persist:bit-agent-browser";
// 只放行复制到剪贴板；摄像头、麦克风、定位、通知、全屏等一律拒绝。
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);
const MAX_TABS = 20;
export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
// 这些文件下载后只提供“在文件夹中显示”，不从应用里直接运行。
const EXECUTABLE = new Set([".exe", ".msi", ".msix", ".appx", ".bat", ".cmd", ".com", ".scr", ".ps1", ".psm1", ".vbs",
  ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".lnk", ".reg", ".cpl", ".msc", ".jar", ".pif", ".url"]);

let configuredSession: Session | null = null;
// 下载事件挂在会话上，按发起下载的页面找到它所在的浏览器面板。
const paneByContents = new Map<number, BrowserPane>();

/** 去掉 UA 里的 Electron 和应用名：部分网站会把它当成不受支持的客户端。 */
export function browserUserAgent(userAgent: string): string {
  return userAgent.replace(/\s(?:Electron|bit-agent|BitAgent|@bit-agent\/desktop)\/\S+/giu, "");
}

export function nextZoom(current: number, direction: "in" | "out"): number {
  if (direction === "in") return ZOOM_LEVELS.find((level) => level > current + 0.001) ?? ZOOM_LEVELS.at(-1)!;
  return [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.001) ?? ZOOM_LEVELS[0]!;
}

export function isExecutable(filename: string): boolean {
  return EXECUTABLE.has(extname(filename).toLowerCase());
}

/** 下载目录里不重名的文件路径：重名时加“ (1)”“ (2)”。 */
export function uniquePath(directory: string, filename: string, exists: (path: string) => boolean = existsSync): string {
  const safe = basename(filename).replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").trim() || "download";
  const extension = extname(safe);
  const stem = safe.slice(0, safe.length - extension.length);
  let candidate = join(directory, safe);
  for (let index = 1; exists(candidate); index += 1) candidate = join(directory, `${stem} (${index})${extension}`);
  return candidate;
}

function browserSession(): Session {
  if (configuredSession) return configuredSession;
  const browser = session.fromPartition(BROWSER_PARTITION);
  browser.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  browser.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
  browser.setUserAgent(browserUserAgent(browser.getUserAgent()));
  browser.on("will-download", (_event, item, contents) => {
    const pane = contents ? paneByContents.get(contents.id) : undefined;
    if (!pane) { item.cancel(); return; }
    pane.download(item);
  });
  configuredSession = browser;
  return browser;
}

function cleanBounds(bounds: BrowserBounds, window: BrowserWindow): Electron.Rectangle {
  const [maxWidth = 0, maxHeight = 0] = window.getContentSize();
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0);
  const x = Math.min(Math.max(0, number(bounds.x)), maxWidth);
  const y = Math.min(Math.max(0, number(bounds.y)), maxHeight);
  return { x, y, width: Math.min(Math.max(0, number(bounds.width)), maxWidth - x), height: Math.min(Math.max(0, number(bounds.height)), maxHeight - y) };
}

type Shortcut = BrowserShortcut | "reload" | "hard-reload" | "back" | "forward" | "devtools"
  | "zoom-in" | "zoom-out" | "zoom-reset" | "print";

/** 页面获得焦点时，应用和浏览器的快捷键也要能用；返回 null 表示交给网页自己处理。 */
export function shortcutFor(input: Pick<Electron.Input, "type" | "key" | "code" | "control" | "meta" | "alt" | "shift">): Shortcut | null {
  if (input.type !== "keyDown") return null;
  const command = input.control || input.meta;
  const key = input.key.toLowerCase();
  if (command && !input.alt) {
    if (key === "tab") return input.shift ? "previous-tab" : "next-tab";
    if (key === "r") return input.shift ? "hard-reload" : "reload";
    if (key === "i" && input.shift) return "devtools";
    if (key === "=" || key === "+" || input.code === "NumpadAdd") return "zoom-in";
    if (key === "-" || key === "_" || input.code === "NumpadSubtract") return "zoom-out";
    if (!input.shift) {
      if (key === "l") return "focus-address";
      if (key === "f") return "find";
      if (key === "b") return "toggle-sidebar";
      if (input.code === "Backquote") return "toggle-terminal";
      if (key === "t") return "new-tab";
      if (key === "w") return "close-tab";
      if (key === "0" || input.code === "Numpad0") return "zoom-reset";
      if (key === "p") return "print";
    }
  }
  if (!command && !input.shift && input.alt && key === "arrowleft") return "back";
  if (!command && !input.shift && input.alt && key === "arrowright") return "forward";
  if (!command && !input.alt && key === "f5") return input.shift ? "hard-reload" : "reload";
  if (!command && !input.alt && !input.shift && key === "f12") return "devtools";
  return null;
}

interface Tab {
  id: string;
  view: WebContentsView;
  favicon: string | null;
  error: BrowserState["error"];
  /** 恢复的标签页先不加载，第一次切换过去时再打开。 */
  pending: { url: string; title: string } | null;
}

export class BrowserPane {
  private readonly tabs: Tab[] = [];
  private activeId: string | null = null;
  private visible = false;
  private bounds: Electron.Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private readonly downloads = new Map<string, Electron.DownloadItem>();

  constructor(private readonly window: BrowserWindow) {
    // 应用页面重新加载时，新页面还不知道浏览器开着；先把网页视图藏起来，等它重新要求显示。
    window.webContents.on("did-start-loading", () => {
      this.visible = false;
      this.layout();
    });
    window.once("closed", () => {
      for (const tab of this.tabs) this.destroyTab(tab);
      this.tabs.length = 0;
    });
  }

  private get active(): Tab | undefined { return this.tabs.find((tab) => tab.id === this.activeId); }

  private createTab(): Tab {
    if (this.tabs.length >= MAX_TABS) throw new Error(`最多同时打开 ${MAX_TABS} 个标签页`);
    const view = new WebContentsView({ webPreferences: {
      session: browserSession(), sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, spellcheck: false, safeDialogs: true,
    } });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    const tab: Tab = { id: randomUUID(), view, favicon: null, error: null, pending: null };
    const contents = view.webContents;
    paneByContents.set(contents.id, this);
    // 新窗口（target=_blank、window.open、中键点击）在新标签页打开；后台标签页的请求不切换过去。
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (isBrowsableUrl(url)) {
        try { this.newTab(url, { activate: disposition !== "background-tab" }); } catch { void contents.loadURL(url).catch(() => {}); }
      }
      return { action: "deny" };
    });
    const guard = (event: Electron.Event, url: string) => { if (!isBrowsableUrl(url)) event.preventDefault(); };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("did-start-loading", () => { tab.error = null; this.emit(); });
    contents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) tab.favicon = null;
    });
    for (const name of ["did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const) {
      contents.on(name as "did-stop-loading", () => this.emit());
    }
    contents.on("page-favicon-updated", (_event, favicons) => {
      tab.favicon = favicons.find((icon) => /^(https?:|data:image\/)/u.test(icon)) ?? null;
      this.emit();
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 是用户或页面自己中止（例如点了停止、重定向），不算失败。
      if (!isMainFrame || code === -3) return;
      tab.error = { code, description, url };
      this.emit();
    });
    contents.on("render-process-gone", (_event, details) => {
      tab.error = { code: -1, description: `页面进程已退出（${details.reason}）`, url: contents.getURL() };
      this.emit();
    });
    contents.on("zoom-changed", (_event, direction) => { this.zoom(tab, nextZoom(contents.getZoomFactor(), direction)); });
    contents.on("context-menu", (_event, params) => this.contextMenu(tab, params));
    contents.on("before-input-event", (event, input) => {
      const shortcut = shortcutFor(input);
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut === "devtools") contents.openDevTools({ mode: "detach" });
      else if (shortcut === "hard-reload") contents.reloadIgnoringCache();
      else if (["reload", "back", "forward", "zoom-in", "zoom-out", "zoom-reset", "print"].includes(shortcut)) {
        void this.action(shortcut as BrowserAction);
      } else {
        this.window.webContents.focus();
        this.window.webContents.send("browser:shortcut", shortcut);
      }
    });
    this.window.contentView.addChildView(view);
    this.tabs.push(tab);
    return tab;
  }

  private destroyTab(tab: Tab): void {
    paneByContents.delete(tab.view.webContents.id);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  private tabState(tab: Tab): BrowserTab {
    const contents = tab.view.webContents;
    const url = tab.pending?.url ?? (contents.isDestroyed() ? "" : contents.getURL());
    const title = tab.pending?.title ?? (contents.isDestroyed() ? "" : contents.getTitle());
    return { id: tab.id, url: url === "about:blank" ? "" : url, title: title === "about:blank" ? "" : title,
      loading: !tab.pending && !contents.isDestroyed() && contents.isLoading(), favicon: tab.favicon };
  }

  state(): BrowserState {
    const tabs = this.tabs.map((tab) => this.tabState(tab));
    const active = this.active;
    const current = tabs.find((tab) => tab.id === this.activeId);
    const contents = active?.view.webContents;
    const live = contents && !contents.isDestroyed() && !active.pending;
    return { tabs, activeId: this.activeId, url: current?.url ?? "", title: current?.title ?? "", loading: current?.loading ?? false,
      canGoBack: live ? contents.navigationHistory.canGoBack() : false,
      canGoForward: live ? contents.navigationHistory.canGoForward() : false,
      zoom: live ? contents.getZoomFactor() : 1, error: active?.error ?? null };
  }

  private emit(): void {
    if (!this.window.isDestroyed()) this.window.webContents.send("browser:state", this.state());
  }

  /** 只显示当前标签页的视图，其余隐藏。 */
  private layout(): void {
    for (const tab of this.tabs) {
      const show = this.visible && tab.id === this.activeId;
      if (show) tab.view.setBounds(this.bounds);
      tab.view.setVisible(show);
    }
  }

  async show(bounds: BrowserBounds, url?: string): Promise<BrowserState> {
    this.bounds = cleanBounds(bounds, this.window);
    this.visible = true;
    this.layout();
    if (url) await this.navigate(url);
    return this.state();
  }

  setBounds(bounds: BrowserBounds): void {
    this.bounds = cleanBounds(bounds, this.window);
    this.active?.view.setBounds(this.bounds);
  }

  async hide(snapshot: boolean): Promise<string | null> {
    const view = this.active?.view;
    let image: string | null = null;
    // 只在窗口真正显示时截图：窗口隐藏或最小化时不合成画面，capturePage 可能拿到空图甚至卡住主进程。
    const rendering = this.window.isVisible() && !this.window.isMinimized();
    if (snapshot && rendering && this.visible && view && !view.webContents.isDestroyed() && view.webContents.getURL()) {
      const capture = await Promise.race([
        view.webContents.capturePage().catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 400)),
      ]);
      if (capture && !capture.isEmpty()) image = `data:image/jpeg;base64,${capture.toJPEG(85).toString("base64")}`;
    }
    this.visible = false;
    this.layout();
    return image;
  }

  newTab(url?: string, options: { activate?: boolean; lazy?: boolean; title?: string } = {}): string {
    if (url && !isBrowsableUrl(url)) throw new Error("只能打开 http 或 https 地址");
    const tab = this.createTab();
    if (url && options.lazy) tab.pending = { url, title: options.title ?? "" };
    else if (url) void tab.view.webContents.loadURL(url).catch(() => {});
    if (options.activate !== false) this.select(tab.id);
    else this.emit();
    return tab.id;
  }

  select(id: string): void {
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab) return;
    this.activeId = id;
    if (tab.pending) {
      const { url } = tab.pending;
      tab.pending = null;
      void tab.view.webContents.loadURL(url).catch(() => {});
    }
    this.layout();
    this.emit();
  }

  close(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const [tab] = this.tabs.splice(index, 1);
    this.destroyTab(tab!);
    if (this.activeId === id) {
      // 和常见浏览器一样：关掉当前标签页后切到右边那个，没有就切到左边。
      const next = this.tabs[index] ?? this.tabs[index - 1];
      this.activeId = null;
      if (next) { this.select(next.id); return; }
    }
    this.layout();
    this.emit();
  }

  async navigate(url: string): Promise<void> {
    if (!isBrowsableUrl(url)) throw new Error("只能打开 http 或 https 地址");
    const tab = this.active;
    if (!tab) { this.newTab(url); return; }
    tab.error = null;
    tab.pending = null;
    // 加载失败由 did-fail-load 事件报告，这里不再抛错。
    await tab.view.webContents.loadURL(url).catch(() => {});
  }

  private zoom(tab: Tab, factor: number): void {
    tab.view.webContents.setZoomFactor(factor);
    this.emit();
  }

  async action(name: BrowserAction): Promise<void> {
    const tab = this.active;
    if (!tab) return;
    const contents = tab.view.webContents;
    if (name === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (name === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (name === "reload") contents.reload();
    else if (name === "stop") contents.stop();
    else if (name === "devtools") contents.openDevTools({ mode: "detach" });
    else if (name === "external" && isBrowsableUrl(contents.getURL())) await shell.openExternal(contents.getURL());
    else if (name === "zoom-in" || name === "zoom-out") this.zoom(tab, nextZoom(contents.getZoomFactor(), name === "zoom-in" ? "in" : "out"));
    else if (name === "zoom-reset") this.zoom(tab, 1);
    else if (name === "print" && contents.getURL()) contents.print();
  }

  find(text: string, options: { forward?: boolean; next?: boolean }): Promise<{ matches: number; active: number }> {
    const tab = this.active;
    if (!tab) return Promise.resolve({ matches: 0, active: 0 });
    const contents = tab.view.webContents;
    if (!text) { contents.stopFindInPage("clearSelection"); return Promise.resolve({ matches: 0, active: 0 }); }
    return new Promise((resolve) => {
      const timer = setTimeout(() => { contents.off("found-in-page", listener); resolve({ matches: 0, active: 0 }); }, 2000);
      const listener = (_event: Electron.Event, result: Electron.Result) => {
        if (result.requestId !== request || !result.finalUpdate) return;
        clearTimeout(timer);
        contents.off("found-in-page", listener);
        resolve({ matches: result.matches, active: result.activeMatchOrdinal });
      };
      contents.on("found-in-page", listener);
      const request = contents.findInPage(text, { forward: options.forward ?? true, findNext: options.next ?? false });
    });
  }

  stopFind(): void {
    const contents = this.active?.view.webContents;
    if (contents && !contents.isDestroyed()) contents.stopFindInPage("keepSelection");
  }

  // ---- 右键菜单 ----
  private contextMenu(tab: Tab, params: Electron.ContextMenuParams): void {
    const contents = tab.view.webContents;
    const items: Electron.MenuItemConstructorOptions[] = [];
    const section = (entries: Electron.MenuItemConstructorOptions[]) => {
      if (!entries.length) return;
      if (items.length) items.push({ type: "separator" });
      items.push(...entries);
    };
    if (params.linkURL && isBrowsableUrl(params.linkURL)) section([
      { label: "在新标签页中打开链接", click: () => this.newTab(params.linkURL, { activate: true }) },
      { label: "在系统浏览器中打开链接", click: () => void shell.openExternal(params.linkURL) },
      { label: "复制链接地址", click: () => clipboard.writeText(params.linkURL) },
    ]);
    if (params.mediaType === "image" && params.srcURL) section([
      ...(isBrowsableUrl(params.srcURL) ? [{ label: "在新标签页中打开图片", click: () => this.newTab(params.srcURL) }] : []),
      { label: "复制图片", click: () => contents.copyImageAt(params.x, params.y) },
      { label: "复制图片地址", click: () => clipboard.writeText(params.srcURL) },
    ]);
    if (params.isEditable) section([
      { label: "撤销", enabled: params.editFlags.canUndo, click: () => contents.undo() },
      { label: "重做", enabled: params.editFlags.canRedo, click: () => contents.redo() },
      { type: "separator" },
      { label: "剪切", enabled: params.editFlags.canCut, click: () => contents.cut() },
      { label: "复制", enabled: params.editFlags.canCopy, click: () => contents.copy() },
      { label: "粘贴", enabled: params.editFlags.canPaste, click: () => contents.paste() },
      { label: "全选", enabled: params.editFlags.canSelectAll, click: () => contents.selectAll() },
    ]);
    else if (params.selectionText.trim()) {
      const text = params.selectionText.trim();
      const short = text.length > 18 ? `${text.slice(0, 18)}…` : text;
      section([
        { label: "复制", click: () => contents.copy() },
        { label: `搜索“${short}”`, click: () => this.newTab(`${SEARCH_URL}${encodeURIComponent(text.slice(0, 500))}`) },
      ]);
    }
    if (!params.linkURL && params.mediaType === "none" && !params.isEditable && !params.selectionText.trim()) section([
      { label: "后退", enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
      { label: "前进", enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
      { label: "重新加载", click: () => contents.reload() },
      { type: "separator" },
      { label: "打印…", click: () => contents.print() },
    ]);
    section([{ label: "检查元素", click: () => contents.inspectElement(params.x, params.y) }]);
    Menu.buildFromTemplate(items).popup({ window: this.window });
  }

  // ---- 下载：直接存到系统“下载”文件夹，进度发给页面 ----
  download(item: Electron.DownloadItem): void {
    const id = randomUUID();
    const path = uniquePath(app.getPath("downloads"), item.getFilename());
    item.setSavePath(path);
    this.downloads.set(id, item);
    const send = (state: BrowserDownload["state"]) => {
      if (this.window.isDestroyed()) return;
      const download: BrowserDownload = { id, filename: basename(path), path, state, received: item.getReceivedBytes(),
        total: item.getTotalBytes(), executable: isExecutable(path) };
      this.window.webContents.send("browser:download", download);
    };
    item.on("updated", (_event, state) => send(state === "interrupted" ? "interrupted" : "progressing"));
    item.once("done", (_event, state) => send(state));
    send("progressing");
  }

  async downloadAction(id: string, action: "open" | "show" | "cancel"): Promise<void> {
    const item = this.downloads.get(id);
    if (!item) return;
    if (action === "cancel") { item.cancel(); return; }
    const path = item.getSavePath();
    if (action === "show") shell.showItemInFolder(path);
    else if (item.getState() === "completed" && !isExecutable(path)) {
      const failure = await shell.openPath(path);
      if (failure) throw new Error(failure);
    }
  }
}
