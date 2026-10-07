/** 一个终端标签页：xterm.js 实例 + 主进程里的一个 PowerShell。 */
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { FALLBACK_TERMINAL_FONT, loadTerminalFont, TERMINAL_FONT } from "./terminal-font.js";
import { themeFromPage } from "./terminal-theme.js";

export { themeFromPage } from "./terminal-theme.js";

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
  private fontReady = false;
  private disposed = false;

  constructor(private readonly hooks: SessionHooks, private readonly fontSize: number) {
    this.host.className = "terminal-session";
    this.terminal = new Terminal({
      fontFamily: FALLBACK_TERMINAL_FONT, fontSize, lineHeight: 1.25,
      cursorBlink: true, cursorStyle: "bar", cursorInactiveStyle: "bar", cursorWidth: 1,
      scrollback: 5000, allowProposedApi: true, theme: themeFromPage(),
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.loadAddon(this.search);
    this.configureLinks();
    this.terminal.open(this.host);
    this.bindInput();
    this.bindTitle();
  }

  private configureLinks(): void {
    // 输出里的网址：Ctrl+点击在内置浏览器打开；直接点击留给选择文字。
    this.terminal.loadAddon(new WebLinksAddon((event, uri) => {
      if (event.ctrlKey || event.metaKey) this.hooks.openUrl(uri);
    }, { hover: (_event, uri) => { this.host.title = `Ctrl+点击打开 ${uri}`; }, leave: () => { this.host.title = ""; } }));
  }

  private bindInput(): void {
    this.terminal.attachCustomKeyEventHandler((event) => this.handleKey(event));
    this.terminal.onData((data) => {
      if (this.exited) { void this.start(); return; }
      if (this.sessionId) window.bitAgent.writeTerminal(this.sessionId, data);
    });
    // Windows Terminal 的习惯：有选中时右键复制，没有时右键粘贴。
    this.host.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (this.terminal.hasSelection()) void this.copySelection();
      else void this.pasteClipboard();
    });
  }

  private bindTitle(): void {
    this.terminal.onTitleChange((title) => {
      // PowerShell 的可执行文件完整路径不适合作为标签标题。
      if (!title || /\.exe$/iu.test(title.trim())) return;
      this.title = title.slice(0, 60);
      this.hooks.changed();
    });
  }

  private handleKey(event: KeyboardEvent): boolean {
    if (event.type !== "keydown" || !(event.ctrlKey || event.metaKey) || event.altKey) return true;
    const key = event.key.toLowerCase();
    if (key === "c" && (event.shiftKey || this.terminal.hasSelection())) { void this.copySelection(); return false; }
    if (key === "v" || key === "`") return false;
    // Ctrl+= / Ctrl+- / Ctrl+0 交给应用缩放整个界面，不当成 Shell 的按键。
    if (["=", "+", "-", "_", "0"].includes(key) || event.code === "NumpadAdd" || event.code === "NumpadSubtract") return false;
    const shortcut = event.shiftKey ? ({ f: "find", t: "new" } as const)[key as "f"] : undefined;
    if (shortcut) { event.preventDefault(); this.hooks.shortcut(shortcut); return false; }
    return true;
  }

  private async copySelection(): Promise<void> {
    try {
      const text = this.terminal.getSelection();
      if (text) await window.bitAgent.copyText(text);
      this.terminal.clearSelection();
    } catch (error) { this.reportError("复制失败", error); }
  }

  private async pasteClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text && !this.disposed) this.terminal.paste(text);
    } catch (error) { this.reportError("粘贴失败", error); }
  }

  private reportError(label: string, error: unknown): void {
    if (this.disposed) return;
    this.terminal.write(`\r\n\x1b[31m${label}：${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
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
    if (!this.fontReady || this.disposed || !this.host.isConnected || !this.host.clientWidth || !this.host.clientHeight) return;
    this.fit.fit();
    if (this.sessionId) window.bitAgent.resizeTerminal(this.sessionId, this.terminal.cols, this.terminal.rows);
  }

  private async prepareFont(): Promise<boolean> {
    if (this.fontReady) return !this.disposed;
    await loadTerminalFont(this.fontSize);
    if (this.disposed) return false;
    // 更换 fontFamily 会让 xterm 使用加载完成的字体重新测量字符尺寸。
    this.terminal.options.fontFamily = TERMINAL_FONT;
    this.fontReady = true;
    return true;
  }

  async start(): Promise<void> {
    if (this.starting || this.disposed) return;
    this.starting = true;
    this.exited = false;
    const previous = this.sessionId;
    this.sessionId = null;
    try {
      if (previous) await window.bitAgent.closeTerminal(previous);
      if (!(await this.prepareFont())) return;
      this.terminal.reset();
      this.resize();
      const info = await window.bitAgent.openTerminal({ workspaceRoot: this.hooks.workspace(), cols: this.terminal.cols, rows: this.terminal.rows });
      if (this.disposed) { await window.bitAgent.closeTerminal(info.id); return; }
      this.sessionId = info.id;
      this.cwd = info.cwd;
      this.shell = info.shell;
      this.title = /pwsh/iu.test(info.shell) ? "PowerShell 7" : "PowerShell";
    } catch (error) {
      this.exited = true;
      this.reportError("终端启动失败", error);
      if (!this.disposed) this.terminal.write("\x1b[2m按任意键重试\x1b[0m\r\n");
    } finally {
      this.starting = false;
      this.hooks.changed();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const id = this.sessionId;
    this.sessionId = null;
    this.terminal.dispose();
    this.host.remove();
    if (id) await window.bitAgent.closeTerminal(id);
  }
}
