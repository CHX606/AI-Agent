/** 内置终端面板：多个 PowerShell 标签页，用 xterm.js 显示；在对话页和代码仓库页底部都能用。 */
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { mirrorInjectedStyles } from "./style-mirror.js";
import { TerminalSession, themeFromPage } from "./terminal-session.js";

const HEIGHT_KEY = "bit-agent.terminal-height.v1";
// 字号固定；放大缩小用应用的整体缩放（Ctrl+= / Ctrl+-）。
const FONT_SIZE = 12.5;
const MIN_HEIGHT = 120;
const MAX_SESSIONS = 8;
const icon = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;

export interface TerminalPanel {
  toggle(): void;
  isOpen(): boolean;
}

export function mountTerminalPanel(options: {
  panel: HTMLElement;
  toggle: HTMLButtonElement;
  /** 面板跟着当前视图移动：对话页放在对话区底部，代码仓库页放在编辑区底部。 */
  homes: { tasks: HTMLElement; repository: HTMLElement };
  shell: HTMLElement;
  workspace: () => string;
  openUrl: (url: string) => void;
  /** 把终端内容放进输入框，交给 Agent 看。 */
  quote: (text: string) => void;
}): TerminalPanel {
  const { panel, toggle } = options;
  panel.innerHTML = `
    <div class="terminal-resize" role="separator" aria-orientation="horizontal" aria-label="调整终端高度" tabindex="0"></div>
    <header class="terminal-header">
      <div class="terminal-tabs" role="tablist" aria-label="终端"></div>
      <button type="button" class="icon-button" data-action="new" title="新建终端（Ctrl+Shift+T）" aria-label="新建终端">${icon("M12 5v14M5 12h14")}</button>
      <span class="terminal-cwd"></span>
      <div class="terminal-actions">
        <button type="button" class="icon-button" data-action="quote" title="引用到对话：选中的文字，没选中时为最后 60 行" aria-label="引用到对话">${icon("M8 9h8M8 13h5M5 5h14v11H9l-4 3z")}</button>
        <button type="button" class="icon-button" data-action="find" title="查找（Ctrl+Shift+F）" aria-label="查找">${icon("m20 20-4.2-4.2M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0z")}</button>
        <button type="button" class="icon-button" data-action="restart" title="重新启动终端" aria-label="重新启动终端">${icon("M19 7v5h-5M18 11a6.5 6.5 0 1 0-1.6 5.2")}</button>
        <button type="button" class="icon-button" data-action="hide" title="隐藏终端（Ctrl+\`）" aria-label="隐藏终端">${icon("m6 9 6 6 6-6")}</button>
      </div>
    </header>
    <div class="terminal-find" role="search" hidden>
      <input type="text" spellcheck="false" placeholder="在终端中查找" aria-label="在终端中查找">
      <span class="terminal-find-count" aria-live="polite"></span>
      <button type="button" class="icon-button" data-find="previous" title="上一个（Shift+Enter）" aria-label="上一个">${icon("m6 15 6-6 6 6")}</button>
      <button type="button" class="icon-button" data-find="next" title="下一个（Enter）" aria-label="下一个">${icon("m6 9 6 6 6-6")}</button>
      <button type="button" class="icon-button" data-find="close" title="关闭（Esc）" aria-label="关闭查找">${icon("m6 6 12 12M18 6 6 18")}</button>
    </div>
    <div class="terminal-host"></div>`;
  const $ = <T extends HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const host = $(".terminal-host");
  const tabStrip = $(".terminal-tabs");
  const cwdLabel = $(".terminal-cwd");
  const findBar = $(".terminal-find");
  const findInput = $<HTMLInputElement>(".terminal-find input");
  const findCount = $(".terminal-find-count");
  const handle = $(".terminal-resize");
  mirrorInjectedStyles(host);

  const sessions: TerminalSession[] = [];
  let active: TerminalSession | null = null;

  // ---- 会话 ----
  const hooks = {
    workspace: options.workspace,
    openUrl: options.openUrl,
    shortcut: (name: "find" | "new") => {
      if (name === "find") openFind();
      else void createSession();
    },
    changed: () => renderTabs(),
  };

  function renderTabs(): void {
    tabStrip.replaceChildren(...sessions.map((session, index) => {
      const tab = document.createElement("div");
      tab.className = "terminal-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(session === active));
      tab.dataset.exited = String(session.exited);
      const label = document.createElement("span");
      label.textContent = sessions.length > 1 ? `${index + 1}. ${session.title}` : session.title;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "terminal-tab-close";
      close.setAttribute("aria-label", "关闭这个终端");
      close.title = "关闭这个终端";
      close.innerHTML = icon("m7 7 10 10M17 7 7 17");
      close.addEventListener("click", (event) => { event.stopPropagation(); void closeSession(session); });
      tab.append(label, close);
      tab.addEventListener("click", () => select(session));
      tab.addEventListener("auxclick", (event) => { if (event.button === 1) void closeSession(session); });
      return tab;
    }));
    cwdLabel.textContent = active?.cwd ?? "";
    cwdLabel.title = active ? `${active.shell}\n${active.cwd}` : "";
  }

  function select(session: TerminalSession): void {
    if (active === session) { session.terminal.focus(); return; }
    closeFind();
    active = session;
    for (const other of sessions) other.host.hidden = other !== session;
    renderTabs();
    requestResize();
    session.terminal.focus();
  }

  async function createSession(): Promise<void> {
    if (sessions.length >= MAX_SESSIONS) return;
    const session = new TerminalSession(hooks, FONT_SIZE);
    sessions.push(session);
    watchResults(session);
    host.append(session.host);
    select(session);
    await session.start();
    renderTabs();
  }

  async function closeSession(session: TerminalSession): Promise<void> {
    const index = sessions.indexOf(session);
    if (index < 0) return;
    sessions.splice(index, 1);
    await session.dispose();
    if (active === session) {
      active = null;
      const next = sessions[index] ?? sessions[index - 1];
      if (next) select(next);
      else setOpen(false);
    }
    renderTabs();
  }

  window.bitAgent.onTerminalOutput(({ id, data }) => sessions.find((session) => session.sessionId === id)?.write(data));
  window.bitAgent.onTerminalExit(({ id, exitCode }) => sessions.find((session) => session.sessionId === id)?.exit(exitCode));

  let resizeQueued = false;
  function requestResize(): void {
    if (resizeQueued) return;
    resizeQueued = true;
    // 用 setTimeout 而不是 requestAnimationFrame：窗口最小化或隐藏时动画帧会暂停。
    setTimeout(() => { resizeQueued = false; if (isOpen()) active?.resize(); }, 0);
  }
  new ResizeObserver(() => requestResize()).observe(host);

  // ---- 查找 ----
  const decorations = () => {
    const style = getComputedStyle(document.documentElement);
    const brand = style.getPropertyValue("--brand").trim();
    return { matchBackground: style.getPropertyValue("--selection").trim(), activeMatchBackground: brand,
      matchOverviewRuler: brand, activeMatchColorOverviewRuler: brand };
  };
  const find = (backward = false) => {
    if (!active) return;
    const term = findInput.value;
    if (!term) { active.search.clearDecorations(); findCount.textContent = ""; return; }
    const found = backward ? active.search.findPrevious(term, { decorations: decorations() })
      : active.search.findNext(term, { decorations: decorations(), incremental: !backward });
    if (!found) findCount.textContent = "无结果";
  };
  function openFind(): void {
    if (!active) return;
    findBar.hidden = false;
    const selection = active.terminal.getSelection();
    if (selection && !selection.includes("\n")) findInput.value = selection;
    findInput.focus();
    findInput.select();
    if (findInput.value) find();
  }
  function closeFind(): void {
    if (findBar.hidden) return;
    findBar.hidden = true;
    findCount.textContent = "";
    active?.search.clearDecorations();
    // 查找会选中匹配的文字；关掉查找栏后不留着，免得“引用到对话”和复制拿到的是它。
    active?.terminal.clearSelection();
    active?.terminal.focus();
  }
  findInput.addEventListener("input", () => find());
  findInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); find(event.shiftKey); }
    else if (event.key === "Escape") { event.preventDefault(); closeFind(); }
  });
  $("[data-find=previous]").addEventListener("click", () => find(true));
  $("[data-find=next]").addEventListener("click", () => find());
  $("[data-find=close]").addEventListener("click", closeFind);
  function watchResults(session: TerminalSession): void {
    session.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (session !== active || !findInput.value) return;
      findCount.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : "无结果";
    });
  }

  // ---- 头部按钮 ----
  $("[data-action=new]").addEventListener("click", () => void createSession());
  $("[data-action=restart]").addEventListener("click", () => { if (active) void active.start().then(() => active?.terminal.focus()); });
  $("[data-action=hide]").addEventListener("click", () => setOpen(false));
  $("[data-action=find]").addEventListener("click", () => (findBar.hidden ? openFind() : closeFind()));
  $("[data-action=quote]").addEventListener("click", () => {
    const text = active?.excerpt();
    if (text?.trim()) options.quote(text);
  });
  panel.addEventListener("keydown", (event) => {
    if (event.target === findInput || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "f") { event.preventDefault(); openFind(); }
    else if (key === "t") { event.preventDefault(); void createSession(); }
  });

  // 主题切换时更新所有终端的配色。
  new MutationObserver(() => { for (const session of sessions) session.terminal.options.theme = themeFromPage(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ---- 跟着视图移动 ----
  const placeholder = () => (options.shell.dataset.view === "repository" ? options.homes.repository : options.homes.tasks);
  function relocate(): void {
    const home = placeholder();
    if (panel.parentElement === home) return;
    const footer = home.querySelector(":scope > .editor-status");
    home.insertBefore(panel, footer);
    requestResize();
  }
  new MutationObserver(relocate).observe(options.shell, { attributes: true, attributeFilter: ["data-view"] });

  // ---- 拖动顶边调整高度；高度记在本机 ----
  const applyHeight = (height: number) => {
    const container = panel.parentElement?.clientHeight ?? window.innerHeight;
    const clamped = Math.round(Math.min(Math.max(MIN_HEIGHT, height), Math.max(MIN_HEIGHT, container - 240)));
    panel.style.setProperty("--terminal-height", `${clamped}px`);
    return clamped;
  };
  const stored = Number(localStorage.getItem(HEIGHT_KEY));
  applyHeight(Number.isFinite(stored) && stored > 0 ? stored : 260);
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    document.body.dataset.resizing = "true";
    const move = (moveEvent: PointerEvent) => { applyHeight(startHeight + startY - moveEvent.clientY); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("lostpointercapture", () => {
      handle.removeEventListener("pointermove", move);
      delete document.body.dataset.resizing;
      localStorage.setItem(HEIGHT_KEY, String(Math.round(panel.getBoundingClientRect().height)));
    }, { once: true });
  });
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 60 : 20;
    const delta = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    localStorage.setItem(HEIGHT_KEY, String(applyHeight(panel.getBoundingClientRect().height + delta)));
  });

  // ---- 打开和隐藏 ----
  const isOpen = () => panel.hidden === false;
  function setOpen(open: boolean): void {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.classList.toggle("is-active", open);
    if (!open) { closeFind(); return; }
    relocate();
    if (!sessions.length) void createSession();
    else { requestResize(); active?.terminal.focus(); }
  }

  toggle.addEventListener("click", () => setOpen(!isOpen()));
  setOpen(false);
  return { toggle: () => setOpen(!isOpen()), isOpen };
}
