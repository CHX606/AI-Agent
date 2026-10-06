/** 一个终端标签页：xterm.js 实例 + 主进程里的一个 PowerShell。 */
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";

const ansi = {
  light: { black: "#262624", red: "#c84b45", green: "#3d9140", yellow: "#a87a12", blue: "#3973b8", magenta: "#9a4fb0",
    cyan: "#2b8a94", white: "#7b7b74", brightBlack: "#5c5c57", brightRed: "#d9625b", brightGreen: "#4fa752",
    brightYellow: "#b98a1c", brightBlue: "#4b86cc", brightMagenta: "#ad62c2", brightCyan: "#36a0ab", brightWhite: "#9a9a92" },
  dark: { black: "#3a3a36", red: "#df7b74", green: "#7cbd7d", yellow: "#d8b45f", blue: "#7eabd5", magenta: "#c79ad6",
    cyan: "#6fc0c6", white: "#d6d3cb", brightBlack: "#77746c", brightRed: "#eb948e", brightGreen: "#96cf97",
    brightYellow: "#e6c77a", brightBlue: "#9cc0e3", brightMagenta: "#d6b2e2", brightCyan: "#8fd0d5", brightWhite: "#f4f2ec" },
} satisfies Record<string, ITheme>;

export function themeFromPage(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string) => style.getPropertyValue(name).trim();
  const dark = document.documentElement.dataset.theme === "dark";
  return { ...ansi[dark ? "dark" : "light"], background: value("--bg-main"), foreground: value("--text"),
    cursor: value("--brand"), cursorAccent: value("--bg-main"), selectionBackground: value("--selection") };
}

export interface SessionHooks {
  workspace(): string;
  openUrl(url: string): void;
  /** 终端里按下、需要交给面板处理的快捷键。 */
  shortcut(name: "find" | "new"): void;
  changed(): void;
}

let counter = 0;

export class TerminalSession {
  readonly key = `t${++counter}`;
  readonly host = document.createElement("div");
  readonly terminal: Terminal;
  readonly search = new SearchAddon();
  private readonly fit = new FitAddon();
  sessionId: string | null = null;
  title = "PowerShell";
  cwd = "";
  shell = "";
  exited = false;
  private starting = false;

  constructor(private readonly hooks: SessionHooks, fontSize: number) {
    this.host.className = "terminal-session";
    this.terminal = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "Consolas, monospace",
      fontSize, lineHeight: 1.2, cursorBlink: true, scrollback: 5000, allowProposedApi: true, theme: themeFromPage(),
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.loadAddon(this.search);
    // 输出里的网址：Ctrl+点击在内置浏览器打开；直接点击留给选择文字。
    this.terminal.loadAddon(new WebLinksAddon((event, uri) => {
      if (event.ctrlKey || event.metaKey) hooks.openUrl(uri);
    }, { hover: (_event, uri) => { this.host.title = `Ctrl+点击打开 ${uri}`; }, leave: () => { this.host.title = ""; } }));
    this.terminal.open(this.host);
    this.terminal.attachCustomKeyEventHandler((event) => this.handleKey(event));
    this.terminal.onData((data) => {
      if (this.exited) { void this.start(); return; }
      if (this.sessionId) window.bitAgent.writeTerminal(this.sessionId, data);
    });
    this.terminal.onTitleChange((title) => {
      // PowerShell 会把窗口标题设成可执行文件的完整路径，这种没有信息量，不显示。
      if (title && !/\.exe$/iu.test(title.trim())) { this.title = title.slice(0, 60); hooks.changed(); }
    });
    // Windows Terminal 的习惯：有选中时右键复制，没有时右键粘贴。
    this.host.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (this.terminal.hasSelection()) { void this.copySelection(); return; }
      void navigator.clipboard.readText().then((text) => { if (text) this.terminal.paste(text); }).catch(() => {});
    });
  }

  private handleKey(event: KeyboardEvent): boolean {
    if (event.type !== "keydown" || !(event.ctrlKey || event.metaKey) || event.altKey) return true;
    const key = event.key.toLowerCase();
    if (key === "c" && (event.shiftKey || this.terminal.hasSelection())) { void this.copySelection(); return false; }
    if (key === "v") return false;
    if (key === "`") return false;
    // Ctrl+= / Ctrl+- / Ctrl+0 交给应用缩放整个界面（终端跟着放大缩小），不当成 Shell 的按键。
    if (["=", "+", "-", "_", "0"].includes(key) || event.code === "NumpadAdd" || event.code === "NumpadSubtract") return false;
    const shortcut = event.shiftKey ? ({ f: "find", t: "new" } as const)[key as "f"] : undefined;
    if (shortcut) { event.preventDefault(); this.hooks.shortcut(shortcut); return false; }
    return true;
  }

  private async copySelection(): Promise<void> {
    const text = this.terminal.getSelection();
    if (text) await window.bitAgent.copyText(text);
    this.terminal.clearSelection();
  }

  /** 选中的文字；没有选中时取最后 lines 行（去掉末尾空行）。 */
  excerpt(lines = 60): string {
    const selection = this.terminal.getSelection();
    if (selection.trim()) return selection.replace(/\s+$/u, "");
    const buffer = this.terminal.buffer.active;
    const rows: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) rows.push(buffer.getLine(index)?.translateToString(true) ?? "");
    while (rows.length && !rows.at(-1)!.trim()) rows.pop();
    return rows.slice(-lines).join("\n");
  }

  write(data: string): void { this.terminal.write(data); }

  exit(exitCode: number): void {
    this.sessionId = null;
    this.exited = true;
    this.terminal.write(`\r\n\x1b[2m[进程已退出，代码 ${exitCode}。按任意键重新启动]\x1b[0m\r\n`);
    this.hooks.changed();
  }

  resize(): void {
    if (!this.host.isConnected || !this.host.clientWidth || !this.host.clientHeight) return;
    this.fit.fit();
    if (this.sessionId) window.bitAgent.resizeTerminal(this.sessionId, this.terminal.cols, this.terminal.rows);
  }

  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.exited = false;
    const previous = this.sessionId;
    this.sessionId = null;
    if (previous) await window.bitAgent.closeTerminal(previous).catch(() => {});
    this.terminal.reset();
    try {
      this.resize();
      const info = await window.bitAgent.openTerminal({ workspaceRoot: this.hooks.workspace(), cols: this.terminal.cols, rows: this.terminal.rows });
      this.sessionId = info.id;
      this.cwd = info.cwd;
      this.shell = info.shell;
      this.title = /pwsh/iu.test(info.shell) ? "PowerShell 7" : "PowerShell";
    } catch (error) {
      this.exited = true;
      this.terminal.write(`\x1b[31m终端启动失败：${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n\x1b[2m按任意键重试\x1b[0m\r\n`);
    } finally {
      this.starting = false;
      this.hooks.changed();
    }
  }

  async dispose(): Promise<void> {
    const id = this.sessionId;
    this.sessionId = null;
    this.terminal.dispose();
    this.host.remove();
    if (id) await window.bitAgent.closeTerminal(id).catch(() => {});
  }
}
