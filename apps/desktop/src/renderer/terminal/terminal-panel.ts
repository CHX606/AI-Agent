/** xterm 终端会话面板：位置、查找与显示分别交给专用模块。 */
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { mirrorInjectedStyles } from "./style-mirror.js";
import { TerminalFind } from "./terminal-find.js";
import { terminalIcon, terminalMarkup } from "./terminal-markup.js";
import { POSITION_CHANGED, readTerminalPosition } from "./terminal-position.js";
import { TerminalSession, themeFromPage } from "./terminal-session.js";
import { TerminalSizing } from "./terminal-sizing.js";

const MAX_SESSIONS = 8;

export interface TerminalPanel {
  toggle(): void;
  close(): void;
  isOpen(): boolean;
}

interface PanelOptions {
  panel: HTMLElement;
  toggle: HTMLButtonElement;
  homes: { tasks: HTMLElement; repository: HTMLElement; right: HTMLElement };
  shell: HTMLElement;
  workspace(): string;
  openUrl(url: string): void;
  quote(text: string): void;
}

class TerminalPanelController implements TerminalPanel {
  private readonly sessions: TerminalSession[] = [];
  private active: TerminalSession | null = null;
  private readonly host: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly cwd: HTMLElement;
  private readonly find: TerminalFind;
  private readonly sizing: TerminalSizing;
  private resizeQueued = false;

  constructor(private readonly options: PanelOptions) {
    options.panel.innerHTML = terminalMarkup;
    this.host = this.element(".terminal-host");
    this.tabs = this.element(".terminal-tabs");
    this.cwd = this.element(".terminal-cwd");
    mirrorInjectedStyles(this.host);
    this.find = new TerminalFind(options.panel, () => this.active);
    this.sizing = new TerminalSizing({ ...options, resized: () => this.requestResize() });
    this.bindControls();
    this.bindRuntime();
    this.sizing.setPosition(readTerminalPosition());
    this.setOpen(false);
  }

  private element<T extends HTMLElement>(selector: string): T {
    return this.options.panel.querySelector<T>(selector)!;
  }

  private createTab(session: TerminalSession, index: number): HTMLElement {
    const tab = document.createElement("div");
    tab.className = "terminal-tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(session === this.active));
    tab.dataset.exited = String(session.exited);
    const label = document.createElement("span");
    label.textContent = this.sessions.length > 1 ? `${index + 1}. ${session.title}` : session.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "terminal-tab-close";
    close.setAttribute("aria-label", "关闭这个终端");
    close.title = "关闭这个终端";
    close.innerHTML = terminalIcon("m7 7 10 10M17 7 7 17");
    close.addEventListener("click", (event) => { event.stopPropagation(); void this.closeSession(session); });
    tab.append(label, close);
    tab.addEventListener("click", () => this.select(session));
    tab.addEventListener("auxclick", (event) => { if (event.button === 1) void this.closeSession(session); });
    return tab;
  }

  private renderTabs(): void {
    this.tabs.replaceChildren(...this.sessions.map((session, index) => this.createTab(session, index)));
    this.cwd.textContent = this.active?.cwd ?? "";
    this.cwd.title = this.active ? `${this.active.shell}\n${this.active.cwd}` : "";
    this.element<HTMLButtonElement>("[data-action=new]").disabled = this.sessions.length >= MAX_SESSIONS;
  }

  private select(session: TerminalSession): void {
    if (this.active === session) { session.terminal.focus(); return; }
    this.find.close();
    this.active = session;
    for (const other of this.sessions) other.host.hidden = other !== session;
    this.renderTabs();
    this.requestResize();
    session.terminal.focus();
  }

  private async createSession(): Promise<void> {
    if (this.sessions.length >= MAX_SESSIONS) return;
    const session = new TerminalSession({
      workspace: this.options.workspace, openUrl: this.options.openUrl,
      shortcut: (name) => { if (name === "find") this.find.open(); else void this.createSession(); },
      changed: () => this.renderTabs(),
    }, 13);
    this.sessions.push(session);
    this.find.watch(session);
    this.host.append(session.host);
    this.select(session);
    await session.start();
    this.renderTabs();
  }

  private async closeSession(session: TerminalSession): Promise<void> {
    const index = this.sessions.indexOf(session);
    if (index < 0) return;
    this.sessions.splice(index, 1);
    await session.dispose();
    if (this.active === session) {
      this.active = null;
      const next = this.sessions[index] ?? this.sessions[index - 1];
      if (next) this.select(next);
      else this.setOpen(false);
    }
    this.renderTabs();
  }

  private requestResize(): void {
    if (this.resizeQueued) return;
    this.resizeQueued = true;
    setTimeout(() => { this.resizeQueued = false; if (this.isOpen()) this.active?.resize(); }, 0);
  }

  private bindControls(): void {
    this.element("[data-action=new]").addEventListener("click", () => void this.createSession());
    this.element("[data-action=restart]").addEventListener("click", () => void this.restart());
    this.element("[data-action=hide]").addEventListener("click", () => this.close());
    this.element("[data-action=find]").addEventListener("click", () => this.find.toggle());
    this.element("[data-action=quote]").addEventListener("click", () => {
      const text = this.active?.excerpt();
      if (text?.trim()) this.options.quote(text);
    });
    this.options.toggle.addEventListener("click", () => this.toggle());
    this.options.panel.addEventListener("keydown", (event) => this.shortcut(event));
    window.addEventListener(POSITION_CHANGED, () => this.sizing.setPosition(readTerminalPosition()));
  }

  private shortcut(event: KeyboardEvent): void {
    if (event.target === this.element(".terminal-find input") || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "f") { event.preventDefault(); this.find.open(); }
    else if (key === "t") { event.preventDefault(); void this.createSession(); }
  }

  private bindRuntime(): void {
    window.bitAgent.onTerminalOutput(({ id, data }) => this.sessions.find((session) => session.sessionId === id)?.write(data));
    window.bitAgent.onTerminalExit(({ id, exitCode }) => this.sessions.find((session) => session.sessionId === id)?.exit(exitCode));
    new ResizeObserver(() => this.requestResize()).observe(this.host);
    new MutationObserver(() => {
      for (const session of this.sessions) session.terminal.options.theme = themeFromPage();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  private async restart(): Promise<void> {
    const session = this.active;
    if (!session) return;
    await session.start();
    if (session === this.active) session.terminal.focus();
  }

  private setOpen(open: boolean): void {
    this.options.panel.hidden = !open;
    this.options.shell.dataset.terminalOpen = String(open);
    this.options.toggle.setAttribute("aria-expanded", String(open));
    this.options.toggle.classList.toggle("is-active", open);
    if (!open) { this.find.close(); return; }
    this.sizing.relocate();
    if (!this.sessions.length) void this.createSession();
    else { this.requestResize(); this.active?.terminal.focus(); }
  }

  toggle(): void { this.setOpen(!this.isOpen()); }
  close(): void { this.setOpen(false); }
  isOpen(): boolean { return !this.options.panel.hidden; }
}

export function mountTerminalPanel(options: PanelOptions): TerminalPanel {
  return new TerminalPanelController(options);
}
