/**
 * 右侧的内置浏览器。网页本身是主进程里的原生视图（WebContentsView，每个标签页一个），盖在页面上方；
 * 这里负责标签栏、工具栏、起始页、错误页、查找栏、下载栏，并让原生视图始终对齐 .browser-stage 的位置。
 * 原生视图会挡住页面里的弹窗和菜单，所以它们出现在浏览器区域上方时，先换成静态截图再隐藏视图。
 */
import { browserAddress, displayAddress } from "../../shared/browser-address.js";
import { browserErrorMessage } from "../../shared/browser-errors.js";
import type { BrowserBounds, BrowserShortcut, BrowserState } from "../../shared/contracts.js";
import "./browser.css";
import { mountDownloads } from "./browser-downloads.js";
import { bookmarks, isBookmarked, recentVisits, recordVisit, toggleBookmark } from "./browser-history.js";
import { browserMarkup } from "./browser-markup.js";
import { mountPrompts } from "./browser-prompts.js";
import { mountSuggestions } from "./browser-suggestions.js";
import { renderTabs, tabTitle } from "./browser-tabs.js";

const WIDTH_KEY = "bit-agent.browser-width.v1";
const TABS_KEY = "bit-agent.browser-tabs.v1";
const MIN_WIDTH = 360;
const MAIN_MIN_WIDTH = 420;
// 这些元素出现在网页区域上方时，原生视图要先让开（换成截图）。
const OVERLAYS = "dialog[open], .choice-popover:not([hidden]), #profile-menu:not([hidden]), .browser-suggestions:not([hidden])";

interface Recent { url: string; title: string }
interface SavedTabs { tabs: Recent[]; active: number }

function readJson<T>(key: string, fallback: T): T {
  try { return (JSON.parse(localStorage.getItem(key) ?? "null") as T | null) ?? fallback; } catch { return fallback; }
}

export interface BrowserPaneController {
  open(url?: string): void;
  /** 在新标签页打开（对话里的链接用）。 */
  openInNewTab(url: string): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

export function mountBrowserPane(options: {
  shell: HTMLElement;
  pane: HTMLElement;
  toggle: HTMLButtonElement;
  /** 浏览器页面里按下的应用快捷键（Ctrl+B、Ctrl+`）。 */
  onShortcut: (shortcut: BrowserShortcut) => void;
}): BrowserPaneController {
  const { shell, pane, toggle } = options;
  pane.innerHTML = browserMarkup;
  const $ = <T extends HTMLElement>(selector: string) => pane.querySelector<T>(selector)!;
  const form = $<HTMLFormElement>(".browser-address");
  const address = $<HTMLInputElement>(".browser-address input");
  const zoomBadge = $<HTMLButtonElement>(".browser-zoom");
  const tabStrip = $(".browser-tabs");
  const stage = $(".browser-stage");
  const snapshot = $<HTMLImageElement>(".browser-snapshot");
  const start = $(".browser-start");
  const failure = $(".browser-error");
  const progress = $(".browser-progress");
  const findBar = $(".browser-find");
  const findInput = $<HTMLInputElement>(".browser-find input");
  const findCount = $(".browser-find-count");
  const button = (action: string) => $<HTMLButtonElement>(`.browser-toolbar [data-action="${action}"]`);
  const star = $<HTMLButtonElement>(".browser-bookmark");
  mountDownloads($(".browser-downloads"));
  mountPrompts($(".browser-prompt"));

  let state: BrowserState = { tabs: [], activeId: null, url: "", title: "", loading: false, canGoBack: false,
    canGoForward: false, zoom: 1, error: null, fullscreen: false };
  let open = false;
  let restored = false;
  let viewShown = false;
  let resizing = false;
  let lastBounds = "";
  let syncing: Promise<void> = Promise.resolve();

  // ---- 宽度 ----
  const applyWidth = (width: number) => {
    const sidebar = document.querySelector(".sidebar-left")?.getBoundingClientRect().width ?? 260;
    const clamped = Math.round(Math.min(Math.max(MIN_WIDTH, width), Math.max(MIN_WIDTH, window.innerWidth - sidebar - MAIN_MIN_WIDTH)));
    document.documentElement.style.setProperty("--browser-width", `${clamped}px`);
    return clamped;
  };
  const storedWidth = Number(localStorage.getItem(WIDTH_KEY));
  applyWidth(Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : Math.round(window.innerWidth * 0.42));

  // ---- 原生视图的位置和显示 ----
  const bounds = (): BrowserBounds => {
    const rect = stage.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  };
  const occluded = () => {
    const rect = stage.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(OVERLAYS)].some((element) => {
      if (element.tagName === "DIALOG") return true;
      const other = element.getBoundingClientRect();
      return other.width > 0 && other.left < rect.right && other.right > rect.left && other.top < rect.bottom && other.bottom > rect.top;
    });
  };
  const hasPage = () => Boolean(state.url) && !state.error;
  const wanted = () => open && !resizing && hasPage() && !occluded() && stage.getBoundingClientRect().width > 0;

  /** 按当前状态显示或隐藏原生视图；串行执行，避免显示和隐藏的请求交错。 */
  function sync(): void {
    syncing = syncing.then(async () => {
      const show = wanted();
      if (show && !viewShown) {
        lastBounds = JSON.stringify(bounds());
        await window.bitAgent.showBrowser(bounds());
        viewShown = true;
        // 视图已经画上去之后再拿掉截图，避免闪一下空白。
        setTimeout(() => { if (viewShown) snapshot.hidden = true; }, 60);
      } else if (!show && viewShown) {
        const keepPicture = open && hasPage();
        const picture = await window.bitAgent.hideBrowser(keepPicture);
        viewShown = false;
        if (picture && keepPicture) { snapshot.src = picture; snapshot.hidden = false; }
        else snapshot.hidden = true;
      }
    }).catch(() => { viewShown = false; });
  }

  // 位置变化时跟上。浏览器列贴着窗口右边，位置只会随它自己的尺寸（宽度、查找栏、下载栏）或窗口大小变化。
  // 不用 requestAnimationFrame：窗口最小化或隐藏时它会暂停。
  const follow = () => {
    if (!viewShown) return;
    const next = JSON.stringify(bounds());
    if (next !== lastBounds) { lastBounds = next; window.bitAgent.setBrowserBounds(bounds()); }
  };
  new ResizeObserver(() => { follow(); sync(); }).observe(stage);
  window.addEventListener("resize", follow);
  new MutationObserver(() => sync()).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open", "hidden", "data-view"] });

  // ---- 标签页 ----
  const tabActions = {
    select: (id: string) => { if (id !== state.activeId) { closeFind(); void window.bitAgent.selectBrowserTab(id); } },
    close: (id: string) => void window.bitAgent.closeBrowserTab(id),
  };
  async function newTab(url?: string): Promise<void> {
    closeFind();
    try {
      await window.bitAgent.newBrowserTab(url);
    } catch (error) {
      address.setCustomValidity(error instanceof Error ? error.message : String(error));
      address.reportValidity();
      return;
    }
    if (!url) { address.focus(); void renderStart(); }
  }
  function cycleTab(step: number): void {
    const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
    if (state.tabs.length < 2 || index < 0) return;
    tabActions.select(state.tabs[(index + step + state.tabs.length) % state.tabs.length]!.id);
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function saveTabs(): void {
    if (!restored) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const tabs = state.tabs.filter((tab) => tab.url).map((tab) => ({ url: tab.url, title: tabTitle(tab) }));
      const active = Math.max(0, tabs.findIndex((tab) => tab.url === state.url));
      try { localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active } satisfies SavedTabs)); } catch { /* 存不下就不记 */ }
    }, 400);
  }
  /** 第一次打开时恢复上次的标签页：只加载当前那个，其余切换过去时再加载。 */
  async function restoreTabs(): Promise<void> {
    if (restored) return;
    // 应用页面重新加载过时，主进程里的标签页还在，接上它们，不再从记录里恢复一遍。
    state = await window.bitAgent.getBrowserState().catch(() => state);
    render();
    const saved = readJson<SavedTabs | null>(TABS_KEY, null);
    const tabs = Array.isArray(saved?.tabs) ? saved.tabs.filter((tab) => typeof tab?.url === "string").slice(0, 20) : [];
    if (!state.tabs.length) {
      for (const [index, tab] of tabs.entries()) {
        await window.bitAgent.newBrowserTab(tab.url, { lazy: true, activate: index === saved?.active, title: tab.title })
          .catch(() => undefined);
      }
    }
    restored = true;
  }

  // ---- 页面显示 ----
  function render(): void {
    renderTabs(tabStrip, state.tabs, state.activeId, tabActions);
    start.hidden = Boolean(state.url) || Boolean(state.error);
    failure.hidden = !state.error;
    if (state.error) {
      $(".browser-error-title").textContent = state.error.code === -1 ? "页面已停止运行" : "无法打开这个网页";
      $(".browser-error-detail").textContent = browserErrorMessage(state.error.code, state.error.description);
      $(".browser-error-code").textContent = state.error.code === -1 ? "" : `${state.error.description}（${state.error.code}）`;
      $(".browser-error-url").textContent = state.error.url;
      $(".browser-error-certificate").hidden = !state.error.certificate;
      $(".browser-error [data-proceed]").hidden = !state.error.certificate;
    }
    star.hidden = !hasPage();
    const marked = hasPage() && isBookmarked(state.url);
    star.setAttribute("aria-pressed", String(marked));
    star.title = marked ? "移除书签（Ctrl+D）" : "加入书签（Ctrl+D）";
    star.setAttribute("aria-label", marked ? "移除书签" : "加入书签");
    if (document.activeElement !== address) address.value = state.url ? displayAddress(state.url) : "";
    address.title = state.title ? `${state.title}\n${state.url}` : state.url;
    button("back").disabled = !state.canGoBack;
    button("forward").disabled = !state.canGoForward;
    const reload = button("reload");
    reload.dataset.loading = String(state.loading);
    reload.title = state.loading ? "停止" : "重新加载（F5）";
    reload.setAttribute("aria-label", reload.title);
    button("reload").disabled = !state.url && !state.error;
    button("external").disabled = !state.url;
    button("devtools").disabled = !state.url;
    zoomBadge.hidden = Math.abs(state.zoom - 1) < 0.001;
    zoomBadge.textContent = `${Math.round(state.zoom * 100)}%`;
    progress.dataset.loading = String(state.loading);
    if (!state.url) snapshot.hidden = true;
    sync();
  }

  function remember(): void {
    if (!state.url || state.loading || state.error) return;
    recordVisit(state.url, state.title);
  }
  function toggleStar(): void {
    if (!hasPage()) return;
    toggleBookmark(state.url, state.title);
    render();
  }
  star.addEventListener("click", toggleStar);

  window.bitAgent.onBrowserState((next) => {
    const finished = state.loading && !next.loading && state.activeId === next.activeId;
    const switched = state.activeId !== next.activeId;
    state = next;
    if (switched && !state.url && open) void renderStart();
    render();
    saveTabs();
    if (finished) remember();
  });

  async function navigate(url: string): Promise<void> {
    address.blur();
    state = { ...state, error: null, url: state.url || url, loading: true };
    render();
    await window.bitAgent.navigateBrowser(url);
  }

  // 地址栏建议：输入时列出匹配的书签和历史，上下键选择，回车打开。
  const suggest = mountSuggestions({ input: address, list: $(".browser-suggestions"), open: (url) => void navigate(url) });

  // 不用表单自带的校验：上一次的错误提示会一直拦住提交，粘贴新地址后也提交不了。
  form.noValidate = true;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    address.setCustomValidity("");
    const picked = suggest.picked();
    suggest.close();
    if (picked) { void navigate(picked); return; }
    try {
      const url = browserAddress(address.value);
      if (!url) return;
      void navigate(url);
    } catch (error) {
      address.setCustomValidity(error instanceof Error ? error.message : String(error));
      address.reportValidity();
    }
  });
  address.addEventListener("input", () => address.setCustomValidity(""));
  address.addEventListener("focus", () => { if (state.url) address.value = state.url; address.select(); });
  address.addEventListener("blur", () => { if (state.url) address.value = displayAddress(state.url); });
  address.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !suggest.isOpen()) { address.value = state.url ? displayAddress(state.url) : ""; address.blur(); }
  });

  // ---- 工具栏 ----
  button("back").addEventListener("click", () => void window.bitAgent.browserAction("back"));
  button("forward").addEventListener("click", () => void window.bitAgent.browserAction("forward"));
  button("reload").addEventListener("click", () => {
    if (state.error) void navigate(state.error.url || state.url);
    else void window.bitAgent.browserAction(state.loading ? "stop" : "reload");
  });
  button("external").addEventListener("click", () => void window.bitAgent.browserAction("external"));
  button("devtools").addEventListener("click", () => void window.bitAgent.browserAction("devtools"));
  button("close").addEventListener("click", () => setOpen(false));
  zoomBadge.addEventListener("click", () => void window.bitAgent.browserAction("zoom-reset"));
  $(".browser-new-tab").addEventListener("click", () => void newTab());
  $(".browser-error [data-retry]").addEventListener("click", () => { if (state.error) void navigate(state.error.url); });
  $(".browser-error [data-external]").addEventListener("click", () => {
    if (state.error?.url) window.open(state.error.url, "_blank", "noopener");
  });
  $(".browser-error [data-proceed]").addEventListener("click", () => void window.bitAgent.trustBrowserCertificate());

  // ---- 起始页：本机开发服务器、最近访问 ----
  async function renderStart(): Promise<void> {
    const entry = (item: Recent) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "browser-recent-item";
      const title = document.createElement("strong");
      title.textContent = item.title;
      const url = document.createElement("span");
      url.textContent = displayAddress(item.url);
      element.append(title, url);
      element.addEventListener("click", () => void navigate(item.url));
      return element;
    };
    const marked = bookmarks().slice(0, 8);
    $(".browser-bookmarks").replaceChildren(...marked.map(entry));
    $(".browser-bookmarks-section").hidden = !marked.length;
    const recent = recentVisits(6);
    $(".browser-recent").replaceChildren(...recent.map(entry));
    $(".browser-recent-section").hidden = !recent.length;
    const servers = $(".browser-servers");
    servers.dataset.state = "loading";
    const ports = await window.bitAgent.detectLocalServers().catch(() => []);
    servers.dataset.state = ports.length ? "found" : "empty";
    $(".browser-servers-list").replaceChildren(...ports.map((port) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "browser-server";
      chip.textContent = `localhost:${port}`;
      chip.addEventListener("click", () => void navigate(`http://localhost:${port}/`));
      return chip;
    }));
  }
  $(".browser-servers [data-refresh]").addEventListener("click", () => void renderStart());

  // ---- 页内查找 ----
  let findTimer: ReturnType<typeof setTimeout> | undefined;
  const runFind = async (next: boolean, forward = true) => {
    const result = await window.bitAgent.findInBrowser(findInput.value, { next, forward });
    findCount.textContent = findInput.value ? (result.matches ? `${result.active}/${result.matches}` : "无结果") : "";
  };
  function openFind(): void {
    if (!hasPage()) return;
    findBar.hidden = false;
    findInput.focus();
    findInput.select();
  }
  function closeFind(): void {
    if (findBar.hidden) return;
    findBar.hidden = true;
    findCount.textContent = "";
    window.bitAgent.stopFindInBrowser();
  }
  findInput.addEventListener("input", () => { clearTimeout(findTimer); findTimer = setTimeout(() => void runFind(false), 150); });
  findInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void runFind(true, !event.shiftKey); }
    else if (event.key === "Escape") { event.preventDefault(); closeFind(); }
  });
  $(".browser-find [data-find=previous]").addEventListener("click", () => void runFind(true, false));
  $(".browser-find [data-find=next]").addEventListener("click", () => void runFind(true, true));
  $(".browser-find [data-find=close]").addEventListener("click", closeFind);

  // ---- 快捷键：焦点在面板（地址栏、标签栏）里时直接处理；焦点在网页里时由主进程转过来 ----
  function shortcut(name: BrowserShortcut | "zoom-in" | "zoom-out" | "zoom-reset" | "print"): void {
    if (name === "focus-address") { address.focus(); address.select(); }
    else if (name === "find") openFind();
    else if (name === "new-tab") void newTab();
    else if (name === "close-tab") { if (state.activeId) tabActions.close(state.activeId); }
    else if (name === "next-tab") cycleTab(1);
    else if (name === "previous-tab") cycleTab(-1);
    else if (name === "bookmark") toggleStar();
    else if (name === "zoom-in" || name === "zoom-out" || name === "zoom-reset" || name === "print") {
      if (hasPage()) void window.bitAgent.browserAction(name);
    } else options.onShortcut(name);
  }
  pane.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    const name = key === "tab" ? (event.shiftKey ? "previous-tab" : "next-tab")
      : event.shiftKey ? (key === "+" ? "zoom-in" : null)
      : ({ f: "find", t: "new-tab", w: "close-tab", l: "focus-address", d: "bookmark", "=": "zoom-in", "+": "zoom-in",
        "-": "zoom-out", "0": "zoom-reset", p: "print" } as const)[key as "f"] ?? null;
    if (!name) return;
    event.preventDefault();
    event.stopPropagation();
    shortcut(name);
  });
  window.bitAgent.onBrowserShortcut((name) => shortcut(name));

  // ---- 拖动左边调整宽度：拖动期间用截图代替原生视图，鼠标事件才不会被网页吃掉 ----
  const handle = $(".browser-resize");
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    resizing = true;
    document.body.dataset.resizing = "true";
    sync();
    const move = (moveEvent: PointerEvent) => applyWidth(window.innerWidth - moveEvent.clientX);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("lostpointercapture", () => {
      handle.removeEventListener("pointermove", move);
      resizing = false;
      delete document.body.dataset.resizing;
      localStorage.setItem(WIDTH_KEY, String(Math.round(pane.getBoundingClientRect().width)));
      sync();
    }, { once: true });
  });
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 80 : 24;
    const delta = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    localStorage.setItem(WIDTH_KEY, String(applyWidth(pane.getBoundingClientRect().width + delta)));
  });
  window.addEventListener("resize", () => {
    const current = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--browser-width"));
    if (Number.isFinite(current)) applyWidth(current);
  });

  // ---- 打开和关闭 ----
  async function setOpen(next: boolean, url?: string, inNewTab = false): Promise<void> {
    const opening = next && !open;
    open = next;
    pane.hidden = !open;
    shell.dataset.browserOpen = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.classList.toggle("is-active", open);
    if (!open) { closeFind(); sync(); return; }
    render();
    if (opening) await restoreTabs();
    if (url) {
      if (inNewTab && state.url) await newTab(url);
      else void navigate(url);
    } else if (opening && !state.url && !state.error) {
      void renderStart();
      address.focus();
    }
  }

  toggle.addEventListener("click", () => void setOpen(!open));
  pane.hidden = true;
  render();
  return {
    open: (url) => void setOpen(true, url),
    openInNewTab: (url) => void setOpen(true, url, true),
    close: () => void setOpen(false),
    toggle: () => void setOpen(!open),
    isOpen: () => open,
  };
}
