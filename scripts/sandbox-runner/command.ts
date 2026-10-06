import { win32 as path } from "node:path";
import type { WindowsBinShell } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRequest } from "./request.js";

function powershell(): WindowsBinShell {
  const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Windows system directory is unavailable");
  return { exe: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand"] };
}

function nativeCommand(payload: string): string {
  return [
    "const {spawnSync}=require('node:child_process')",
    `const task=JSON.parse(Buffer.from("${payload}","base64").toString("utf8"))`,
    "const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTEST_ADDOPTS:'-p no:cacheprovider',PYTHONIOENCODING:'utf-8'}",
    "if(task.pythonPath?.length)env.PYTHONPATH=task.pythonPath.join(';')",
    "const child=spawnSync(task.command[0],task.command.slice(1),{cwd:task.workspace,env,shell:false,stdio:'inherit',windowsHide:true})",
    "if(child.error){console.error(child.error.stack||String(child.error));process.exit(126)}",
    "process.exit(child.status===null?1:child.status)",
  ].join(";\n");
}

function batchCommand(payload: string): string {
  const script = [
    "$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)", "$OutputEncoding=[Console]::OutputEncoding",
    "$env:PYTHONDONTWRITEBYTECODE='1'", "$env:PYTEST_ADDOPTS='-p no:cacheprovider'", "$env:PYTHONIOENCODING='utf-8'",
    `$task=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json)`,
    "if(@($task.pythonPath).Count){$env:PYTHONPATH=(@($task.pythonPath) -join ';')}",
    "Set-Location -LiteralPath $task.workspace", "[Environment]::CurrentDirectory=$task.workspace",
    "$taskProgram=[string]$task.command[0]", "$taskArguments=@($task.command | Select-Object -Skip 1)",
    "& $taskProgram @taskArguments", "$taskSucceeded=$?",
    "if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}", "if(!$taskSucceeded){exit 1}",
  ].join(";\n");
  return Buffer.from(script, "utf16le").toString("base64");
}

export function sandboxCommand(request: Pick<SandboxRequest, "command" | "workspace"> & Partial<Pick<SandboxRequest, "pythonPath">>): {
  command: string; shell: WindowsBinShell;
} {
  const task = { workspace: request.workspace, command: request.command, pythonPath: request.pythonPath };
  const payload = Buffer.from(JSON.stringify(task), "utf8").toString("base64");
  if (/\.(?:cmd|bat)$/iu.test(request.command[0]!)) return { command: batchCommand(payload), shell: powershell() };
  return { command: nativeCommand(payload), shell: { exe: process.execPath, args: ["-e"] } };
}
