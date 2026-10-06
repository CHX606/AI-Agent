/** 对话区底部的内置终端：主进程里的 PowerShell，用 xterm.js 显示。 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { mirrorInjectedStyles } from "./style-mirror.js";

const HEIGHT_KEY = "bit-agent.terminal-height.v1";
const MIN_HEIGHT = 120;

const ansi = {
  light: { black: "#262624", red: "#c84b45", green: "#3d9140", yellow: "#a87a12", blue: "#3973b8", magenta: "#9a4fb0",
    cyan: "#2b8a94", white: "#7b7b74", brightBlack: "#5c5c57", brightRed: "#d9625b", brightGreen: "#4fa752",
    brightYellow: "#b98a1c", brightBlue: "#4b86cc", brightMagenta: "#ad62c2", brightCyan: "#36a0ab", brightWhite: "#9a9a92" },
  dark: { black: "#3a3a36", red: "#df7b74", green: "#7cbd7d", yellow: "#d8b45f", blue: "#7eabd5", magenta: "#c79ad6",
    cyan: "#6fc0c6", white: "#d6d3cb", brightBlack: "#77746c", brightRed: "#eb948e", brightGreen: "#96cf97",
    brightYellow: "#e6c77a", brightBlue: "#9cc0e3", brightMagenta: "#d6b2e2", brightCyan: "#8fd0d5", brightWhite: "#f4f2ec" },
} satisfies Record<string, ITheme>;

function themeFromPage(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string) => style.getPropertyValue(name).trim();
  const dark = document.documentElement.dataset.theme === "dark";
  return { ...ansi[dark ? "dark" : "light"], background: value("--bg-main"), foreground: value("--text"),
    cursor: value("--brand"), cursorAccent: value("--bg-main"), selectionBackground: value("--selection") };
}

export interface TerminalPanel {
  toggle(): void;
  isOpen(): boolean;
}

export function mountTerminalPanel(options: { panel: HTMLElement; toggle: HTMLButtonElement; workspace: () => string }): TerminalPanel {
  const { panel, toggle } = options;
  panel.innerHTML = `
    <div class="terminal-resize" role="separator" aria-orientation="horizontal" aria-label="调整终端高度" tabindex="0"></div>
    <header class="terminal-header">
      <span class="terminal-title">终端</span>
      <span class="terminal-cwd"></span>
      <div class="terminal-actions">
        <button type="button" class="icon-button" data-action="restart" title="重新启动终端" aria-label="重新启动终端">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 7v5h-5M18 11a6.5 6.5 0 1 0-1.6 5.2"/></svg>
        </button>
        <button type="button" class="icon-button" data-action="hide" title="隐藏终端（Ctrl+\`）" aria-label="隐藏终端">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
      </div>
    </header>
    <div class="terminal-host"></div>`;
  const host = panel.querySelector<HTMLElement>(".terminal-host")!;
  const cwdLabel = panel.querySelector<HTMLElement>(".terminal-cwd")!;
  const handle = panel.querySelector<HTMLElement>(".terminal-resize")!;
  mirrorInjectedStyles(host);

  const terminal = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "Consolas, monospace",
    fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, allowProposedApi: false,
    theme: themeFromPage(),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);

  let sessionId: string | null = null;
  let starting = false;
  let exited = false;

  // 选中文字时 Ctrl+C 复制，否则照常发给 Shell（中断命令）；Ctrl+V 交给浏览器的粘贴事件。
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown" || !event.ctrlKey || event.altKey) return true;
    const key = event.key.toLowerCase();
    if (key === "c" && (event.shiftKey || terminal.hasSelection())) {
      const text = terminal.getSelection();
      if (text) void window.bitAgent.copyText(text);
      terminal.clearSelection();
      return false;
    }
    if (key === "v") return false;
    if (key === "`") return false;
    return true;
  });

  terminal.onData((data) => {
    if (exited) { void start(); return; }
    if (sessionId) window.bitAgent.writeTerminal(sessionId, data);
  });
  window.bitAgent.onTerminalOutput(({ id, data }) => { if (id === sessionId) terminal.write(data); });
  window.bitAgent.onTerminalExit(({ id, exitCode }) => {
    if (id !== sessionId) return;
    sessionId = null;
    exited = true;
    terminal.write(`\r\n\x1b[2m[进程已退出，代码 ${exitCode}。按任意键重新启动]\x1b[0m\r\n`);
  });

  function resize(): void {
    if (panel.hidden || !host.clientWidth || !host.clientHeight) return;
    fit.fit();
    if (sessionId) window.bitAgent.resizeTerminal(sessionId, terminal.cols, terminal.rows);
  }
  new ResizeObserver(() => resize()).observe(host);

  async function start(): Promise<void> {
    if (starting) return;
    starting = true;
    exited = false;
    const previous = sessionId;
    sessionId = null;
    if (previous) await window.bitAgent.closeTerminal(previous).catch(() => {});
    terminal.reset();
    try {
      resize();
      const info = await window.bitAgent.openTerminal({ workspaceRoot: options.workspace(), cols: terminal.cols, rows: terminal.rows });
      sessionId = info.id;
      cwdLabel.textContent = info.cwd;
      cwdLabel.title = `${info.shell}\n${info.cwd}`;
    } catch (error) {
      exited = true;
      terminal.write(`\x1b[31m终端启动失败：${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n\x1b[2m按任意键重试\x1b[0m\r\n`);
    } finally {
      starting = false;
    }
  }

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.classList.toggle("is-active", open);
    if (!open) return;
    requestAnimationFrame(() => {
      resize();
      if (!sessionId && !exited) void start();
      terminal.focus();
    });
  }

  panel.querySelector("[data-action=restart]")!.addEventListener("click", () => { void start().then(() => terminal.focus()); });
  panel.querySelector("[data-action=hide]")!.addEventListener("click", () => setOpen(false));

  // 主题切换时更新配色。
  new MutationObserver(() => { terminal.options.theme = themeFromPage(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // 拖动顶边调整高度；高度记在本机。
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
    const end = () => {
      handle.removeEventListener("pointermove", move);
      delete document.body.dataset.resizing;
      localStorage.setItem(HEIGHT_KEY, String(Math.round(panel.getBoundingClientRect().height)));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("lostpointercapture", end, { once: true });
  });
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 60 : 20;
    const delta = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    localStorage.setItem(HEIGHT_KEY, String(applyHeight(panel.getBoundingClientRect().height + delta)));
  });

  const isOpen = () => panel.hidden === false;
  toggle.addEventListener("click", () => setOpen(!isOpen()));
  setOpen(false);
  return { toggle: () => setOpen(!isOpen()), isOpen };
}
