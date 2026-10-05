import { realpathSync, statSync } from "node:fs";
import { win32 as path } from "node:path";

export interface SandboxRequest { workspace: string; command: string[]; readPaths: string[] }

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 128
    || value.some(item => typeof item !== "string" || item.includes("\0"))) {
    throw new Error(`Invalid sandbox ${name}`);
  }
  return value as string[];
}

function localPath(value: string, name: string): string {
  if (!path.isAbsolute(value) || value.startsWith("\\\\") || /[\0\r\n]/u.test(value)) {
    throw new Error(`Sandbox ${name} must be an absolute local path`);
  }
  return path.normalize(value);
}

export function parseSandboxRequest(source: string | undefined): SandboxRequest {
  if (!source || source.length > 131072) throw new Error("Missing or oversized sandbox request");
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sandbox request");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "command,readPaths,workspace" || typeof input.workspace !== "string") {
    throw new Error("Invalid sandbox request fields");
  }
  const workspace = realpathSync(localPath(input.workspace, "workspace"));
  if (!statSync(workspace).isDirectory()) throw new Error("Sandbox workspace must be a directory");
  const command = strings(input.command, "command");
  if (!command.length || !command[0]) throw new Error("Sandbox command cannot be empty");
  command[0] = localPath(command[0], "command executable");
  if (/\.(cmd|bat)$/iu.test(command[0]) && command.some(arg => /[&|<>^()%!"\r\n]/u.test(arg))) {
    throw new Error("Batch command arguments cannot contain shell metacharacters");
  }
  const readPaths = strings(input.readPaths, "readPaths").map(item => localPath(item, "read path"));
  return { workspace, command, readPaths: [...new Set(readPaths)] };
}

export function outsideWorkspace(workspace: string, target: string): string {
  const resolved = realpathSync(localPath(target, "runtime path"));
  const relative = path.relative(workspace, resolved);
  if (!relative || (!relative.startsWith("..\\") && !path.isAbsolute(relative))) {
    throw new Error("Sandbox runtime must be outside the writable workspace");
  }
  return resolved;
}
