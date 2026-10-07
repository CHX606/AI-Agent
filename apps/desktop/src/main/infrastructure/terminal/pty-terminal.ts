import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node-pty";
import type { TerminalProcess } from "../../application/ports.js";

/** 优先用 PowerShell 7（pwsh），没有时用系统自带的 Windows PowerShell。 */
export function pickShell(path = process.env.PATH ?? "", systemRoot = process.env.SystemRoot ?? "C:\\Windows"): string {
  for (const directory of path.split(delimiter)) {
    if (directory && existsSync(join(directory, "pwsh.exe"))) return join(directory, "pwsh.exe");
  }
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** 终端继承用户自己的环境变量，但不带本应用内部用的变量（可能影响用户运行的 Electron/Node 程序）。 */
export function terminalEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || /^(BIT_AGENT_|ELECTRON_)/iu.test(key)) continue;
    environment[key] = value;
  }
  environment.TERM_PROGRAM = "BitAgent";
  return environment;
}

// 先让 PowerShell 正常加载用户 profile，再仅替换本会话的提示符。
// -Command 启动的交互会话显式加载 PSReadLine，保留已有模块的颜色与编辑设置。
const SHELL_STARTUP = [
  'function global:prompt { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }',
  'if (-not (Get-Module PSReadLine)) { Import-Module PSReadLine }',
].join("; ");
export function spawnTerminal(input: { cwd: string; cols: number; rows: number }): TerminalProcess {
  const shell = pickShell();
  const cwd = input.cwd || homedir();
  // useConptyDll：用 node-pty 自带的新版 ConPTY（conpty.dll + OpenConsole.exe）。重绘更可靠；
  // 关闭时也不需要 fork 一个子进程去枚举控制台进程（那个子进程在 Electron 里会报 AttachConsole failed）。
  const pty = spawn(shell, ["-NoLogo", "-NoExit", "-Command", SHELL_STARTUP], {
    name: "xterm-256color", cols: input.cols, rows: input.rows, cwd, env: terminalEnvironment(), useConptyDll: true,
  });
  return {
    shell, cwd,
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => { try { pty.kill(); } catch { /* 已经退出 */ } },
    onData: (listener) => { pty.onData(listener); },
    onExit: (listener) => { pty.onExit(({ exitCode }) => listener(exitCode)); },
  };
}
