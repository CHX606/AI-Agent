import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rendered = vi.hoisted(() => ({ fit: vi.fn(), current: null as any }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {
  fit() { rendered.fit(); rendered.current.cols = 42; rendered.current.rows = 10; }
} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80;
  rows = 24;
  write = vi.fn();
  dispose = vi.fn();
  reset = vi.fn();
  loadAddon = vi.fn();
  open = vi.fn();
  attachCustomKeyEventHandler = vi.fn();
  onData = vi.fn();
  onTitleChange = vi.fn();
  constructor(readonly options: any) { rendered.current = this; }
} }));

import { TerminalSession } from "../src/renderer/terminal/terminal-session";
import { TERMINAL_FONT } from "../src/renderer/terminal/terminal-font";

const hooks = { workspace: () => "D:\\repo", openUrl: vi.fn(), shortcut: vi.fn(), changed: vi.fn() };
let fontLoad: ReturnType<typeof vi.fn>;
let openTerminal: ReturnType<typeof vi.fn>;
let closeTerminal: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fontLoad = vi.fn().mockResolvedValue([{ status: "loaded" }]);
  openTerminal = vi.fn().mockResolvedValue({ id: "pty-1", cwd: "D:\\repo", shell: "pwsh.exe" });
  closeTerminal = vi.fn().mockResolvedValue(undefined);
  const host = { isConnected: true, clientWidth: 360, clientHeight: 500, addEventListener: vi.fn(), remove: vi.fn() };
  vi.stubGlobal("document", { documentElement: { dataset: { theme: "dark" } }, createElement: () => host,
    fonts: { load: fontLoad, ready: Promise.resolve() } });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "#202020" }));
  vi.stubGlobal("window", { bitAgent: { openTerminal, closeTerminal, resizeTerminal: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

it("waits for the bundled font and font layout before measuring and opening the PTY", async () => {
  let loaded!: (value: unknown[]) => void;
  let ready!: () => void;
  fontLoad.mockReturnValue(new Promise<unknown[]>(resolve => { loaded = resolve; }));
  Object.assign(document.fonts, { ready: new Promise<void>(resolve => { ready = resolve; }) });
  const session = new TerminalSession(hooks, 13);
  session.resize();
  expect(rendered.fit).not.toHaveBeenCalled();
  const started = session.start();
  expect(fontLoad).toHaveBeenCalledWith('13px "MesloLGS Nerd Font Mono"');
  expect(openTerminal).not.toHaveBeenCalled();
  loaded([{ status: "loaded" }]);
  await Promise.resolve();
  expect(rendered.fit).not.toHaveBeenCalled();
  ready();
  await started;
  expect(session.terminal.options.fontFamily).toBe(TERMINAL_FONT);
  expect(session.terminal.options.lineHeight).toBe(1.25);
  expect(rendered.fit).toHaveBeenCalledOnce();
  expect(openTerminal).toHaveBeenCalledWith({ workspaceRoot: "D:\\repo", cols: 42, rows: 10 });
});

it("reports a missing font resource instead of opening with incorrect cell measurements", async () => {
  fontLoad.mockResolvedValue([]);
  const session = new TerminalSession(hooks, 13);
  await session.start();
  expect(openTerminal).not.toHaveBeenCalled();
  expect(session.exited).toBe(true);
  expect(session.terminal.write).toHaveBeenCalledWith(expect.stringContaining("终端字体资源未加载"));
});

it("does not reopen a closed tab when its font finishes loading", async () => {
  let loaded!: (value: unknown[]) => void;
  fontLoad.mockReturnValue(new Promise<unknown[]>(resolve => { loaded = resolve; }));
  const session = new TerminalSession(hooks, 13);
  const started = session.start();
  await session.dispose();
  loaded([{ status: "loaded" }]);
  await started;
  expect(openTerminal).not.toHaveBeenCalled();
  expect(rendered.fit).not.toHaveBeenCalled();
});

it("closes a PTY that finishes opening after its tab was closed", async () => {
  let opened!: (value: { id: string; cwd: string; shell: string }) => void;
  openTerminal.mockReturnValue(new Promise(resolve => { opened = resolve; }));
  const session = new TerminalSession(hooks, 13);
  const started = session.start();
  await vi.waitFor(() => expect(openTerminal).toHaveBeenCalled());
  await session.dispose();
  opened({ id: "pty-late", cwd: "D:\\repo", shell: "pwsh.exe" });
  await started;
  expect(closeTerminal).toHaveBeenCalledWith("pty-late");
  expect(session.sessionId).toBeNull();
});

it("passes Nerd Font symbols and Chinese output to xterm unchanged", () => {
  const session = new TerminalSession(hooks, 13);
  const output = "\ue0b0 \uf17a 测试 \udb80\udc01\r\n";
  session.write(output);
  expect(session.terminal.write).toHaveBeenCalledExactlyOnceWith(output);
});
