import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  on: new Map<string, (...args: any[]) => void>(),
  handle: new Map<string, (...args: any[]) => unknown>(),
  quit: [] as (() => void)[],
}));
vi.mock("electron", () => ({
  app: { on: (_name: string, listener: () => void) => electron.quit.push(listener) },
  ipcMain: { on: (channel: string, listener: (...args: any[]) => void) => electron.on.set(channel, listener) },
}));
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { pickShell, terminalEnvironment } from "../src/main/infrastructure/terminal/pty-terminal";
import { registerTerminalIpc } from "../src/main/transport/terminal-ipc";

function fakeSender(id: number) {
  const destroyed: (() => void)[] = [];
  return { id, sent: [] as [string, unknown][], isDestroyed: () => false,
    send(channel: string, payload: unknown) { this.sent.push([channel, payload]); },
    once: (_name: string, listener: () => void) => destroyed.push(listener), destroy: () => destroyed.forEach((f) => f()) };
}

function fakeProcess() {
  const listeners = { data: [] as ((data: string) => void)[], exit: [] as ((code: number) => void)[] };
  return { shell: "pwsh.exe", cwd: "", written: [] as string[], sizes: [] as number[][], killed: 0,
    write(data: string) { this.written.push(data); }, resize(cols: number, rows: number) { this.sizes.push([cols, rows]); },
    kill() { this.killed += 1; }, onData: (f: (data: string) => void) => listeners.data.push(f),
    onExit: (f: (code: number) => void) => listeners.exit.push(f), listeners };
}

let processes: ReturnType<typeof fakeProcess>[];
const services = {
  validateRepositoryWorkspace: vi.fn(async (root: string) => `canonical:${root}`),
  spawnTerminal: vi.fn((input: { cwd: string; cols: number; rows: number }) => {
    const child = Object.assign(fakeProcess(), { cwd: input.cwd });
    processes.push(child);
    return child;
  }),
};

beforeEach(() => {
  electron.on.clear(); electron.handle.clear(); electron.quit.length = 0; processes = [];
  vi.useFakeTimers();
  registerTerminalIpc(services as any, (channel, listener) => electron.handle.set(channel, listener));
});
afterEach(() => { vi.useRealTimers(); });

const open = (sender: unknown, input: unknown) => electron.handle.get("terminal:open")!({ sender }, input) as Promise<{ id: string; cwd: string }>;

it("opens in the validated workspace, clamps sizes and batches output to the owning window", async () => {
  const sender = fakeSender(1);
  const info = await open(sender, { workspaceRoot: " D:\\repo ", cols: 9999, rows: -5 });
  expect(info.cwd).toBe("canonical:D:\\repo");
  expect(services.spawnTerminal).toHaveBeenLastCalledWith({ cwd: "canonical:D:\\repo", cols: 500, rows: 2 });
  processes[0]!.listeners.data.forEach((f) => { f("a"); f("b"); });
  expect(sender.sent).toEqual([]);
  vi.advanceTimersByTime(10);
  expect(sender.sent).toEqual([["terminal:output", { id: info.id, data: "ab" }]]);
  processes[0]!.listeners.exit.forEach((f) => f(3));
  expect(sender.sent.at(-1)).toEqual(["terminal:exit", { id: info.id, exitCode: 3 }]);
});

it("opens in the home directory without a workspace", async () => {
  await open(fakeSender(1), { workspaceRoot: "", cols: 80, rows: 24 });
  expect(services.spawnTerminal).toHaveBeenLastCalledWith({ cwd: "", cols: 80, rows: 24 });
});

it("only lets the owning window write, resize or close, and drops oversized input", async () => {
  const owner = fakeSender(1), other = fakeSender(2);
  const { id } = await open(owner, { workspaceRoot: "", cols: 80, rows: 24 });
  const child = processes[0]!;
  electron.on.get("terminal:write")!({ sender: other }, id, "evil");
  electron.on.get("terminal:resize")!({ sender: other }, id, 10, 10);
  await electron.handle.get("terminal:close")!({ sender: other }, id);
  expect(child.written).toEqual([]);
  expect(child.sizes).toEqual([]);
  expect(child.killed).toBe(0);
  electron.on.get("terminal:write")!({ sender: owner }, id, "x".repeat(64 * 1024 + 1));
  electron.on.get("terminal:write")!({ sender: owner }, id, "dir\r");
  electron.on.get("terminal:resize")!({ sender: owner }, id, 120.7, 30);
  expect(child.written).toEqual(["dir\r"]);
  expect(child.sizes).toEqual([[120, 30]]);
  await electron.handle.get("terminal:close")!({ sender: owner }, id);
  expect(child.killed).toBe(1);
});

it("closes a window's terminals when it is destroyed and all of them on quit", async () => {
  const first = fakeSender(1), second = fakeSender(2);
  await open(first, {}); await open(first, {}); await open(second, {});
  first.destroy();
  expect(processes.map((child) => child.killed)).toEqual([1, 1, 0]);
  electron.quit.forEach((f) => f());
  expect(processes.map((child) => child.killed)).toEqual([1, 1, 1]);
});

it("limits terminals per window", async () => {
  const sender = fakeSender(1);
  for (let index = 0; index < 8; index += 1) await open(sender, {});
  await expect(open(sender, {})).rejects.toThrow("最多同时打开 8 个终端");
});

it("prefers pwsh on PATH and falls back to Windows PowerShell", () => {
  const directory = mkdtempSync(join(tmpdir(), "pwsh-"));
  try {
    writeFileSync(join(directory, "pwsh.exe"), "");
    expect(pickShell(`C:\\missing;${directory}`, "C:\\Windows")).toBe(join(directory, "pwsh.exe"));
    expect(pickShell("C:\\missing", "C:\\Windows")).toBe(join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("keeps the user's environment but drops the app's internal variables", () => {
  expect(terminalEnvironment({ PATH: "p", HOME: "h", BIT_AGENT_LOG_DIR: "x", ELECTRON_RUN_AS_NODE: "1", Electron_Foo: "y", EMPTY: undefined }))
    .toEqual({ PATH: "p", HOME: "h", TERM_PROGRAM: "BitAgent" });
});
