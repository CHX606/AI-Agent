import { homedir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node-pty";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));
import { spawnTerminal } from "../src/main/infrastructure/terminal/pty-terminal";

function fakePty() {
  return { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
}
afterEach(() => vi.clearAllMocks());

it("keeps profiles enabled and starts an interactive shell with a plain prompt and PSReadLine", () => {
  vi.mocked(spawn).mockReturnValue(fakePty() as any);
  spawnTerminal({ cwd: "D:\\repo", cols: 100, rows: 30 });
  const [, args, options] = vi.mocked(spawn).mock.calls[0]!;
  expect(args).toContain("-NoExit");
  expect(args).not.toContain("-NoProfile");
  expect(args).not.toContain("-NonInteractive");
  const command = (args as string[]).at(-1)!;
  expect(command).toContain('function global:prompt { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }');
  expect(command).toContain("if (-not (Get-Module PSReadLine)) { Import-Module PSReadLine }");
  expect(options).toMatchObject({ cwd: "D:\\repo", cols: 100, rows: 30, useConptyDll: true });
});

it("keeps terminal output, input and size changes unmodified", () => {
  const pty = fakePty();
  vi.mocked(spawn).mockReturnValue(pty as any);
  const terminal = spawnTerminal({ cwd: "D:\\repo", cols: 80, rows: 24 });
  const receive = vi.fn();
  const exited = vi.fn();
  terminal.onData(receive);
  terminal.onExit(exited);
  const output = "\x1b[36m命令输出\x1b[0m\r\nPS D:\\repo> ";
  pty.onData.mock.calls[0]![0](output);
  pty.onExit.mock.calls[0]![0]({ exitCode: 3 });
  terminal.write("Get-Location\r");
  terminal.resize(120, 40);
  expect(receive).toHaveBeenCalledWith(output);
  expect(exited).toHaveBeenCalledWith(3);
  expect(pty.write).toHaveBeenCalledWith("Get-Location\r");
  expect(pty.resize).toHaveBeenCalledWith(120, 40);
});

it("uses the user's home directory when no workspace is selected", () => {
  vi.mocked(spawn).mockReturnValue(fakePty() as any);
  const terminal = spawnTerminal({ cwd: "", cols: 80, rows: 24 });
  expect(terminal.cwd).toBe(homedir());
  expect(vi.mocked(spawn).mock.calls[0]![2]?.cwd).toBe(homedir());
});
