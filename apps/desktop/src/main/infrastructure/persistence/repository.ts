import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";

import type {
  RepositoryDirectoryResult,
  RepositoryEntry,
  RepositoryFileResult,
} from "../../../shared/contracts.js";

const maximumDirectoryEntries = 500;
const maximumPreviewBytes = 1_000_000;
const protectedDirectories = new Set([".git", ".ssh", ".venv", "node_modules"]);
const privateKeyNames = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const privateKeySuffixes = [".key", ".pem", ".p12", ".pfx"];

import type { RepositoryAccessInput } from "../../application/ports.js";

function canonicalName(name: string): string {
  return name.replace(/[ .]+$/u, "").toLocaleLowerCase("en-US");
}

function isProtectedName(name: string): boolean {
  const canonical = canonicalName(name);
  return (
    protectedDirectories.has(canonical) ||
    canonical === ".env" ||
    canonical.startsWith(".env.") ||
    privateKeyNames.has(canonical) ||
    privateKeySuffixes.some((suffix) => canonical.endsWith(suffix))
  );
}

function validateRelativePath(path: string): string[] {
  if (path.includes("\0")) throw new Error("路径不能包含空字节");
  const normalized = path.replaceAll("\\", "/");
  const parsedWindowsPath = win32.parse(normalized);
  if (
    posix.isAbsolute(normalized) ||
    win32.isAbsolute(normalized) ||
    Boolean(parsedWindowsPath.root)
  ) {
    throw new Error("只允许工作区相对路径");
  }

  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error("路径不能包含 ..");
  if (parts.some((part) => part.includes(":"))) throw new Error("路径不能包含冒号");
  if (parts.some(isProtectedName)) throw new Error("禁止访问受保护的文件或目录");
  return parts;
}

function assertInsideWorkspace(workspaceRoot: string, targetPath: string): void {
  const relativePath = relative(workspaceRoot, targetPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("路径超出当前工作区");
  }
}

export async function validateRepositoryWorkspace(workspaceRoot: string): Promise<string> {
  const requestedRoot = workspaceRoot.trim();
  if (!requestedRoot || !isAbsolute(requestedRoot)) {
    throw new Error("工作区必须是绝对路径");
  }
  const canonicalRoot = await realpath(requestedRoot);
  if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("工作区必须是目录");
  return canonicalRoot;
}

async function resolveRepositoryPath(input: RepositoryAccessInput): Promise<{
  workspaceRoot: string;
  targetPath: string;
}> {
  const parts = validateRelativePath(input.path.trim());
  const workspaceRoot = await validateRepositoryWorkspace(input.workspaceRoot);
  const unresolvedTarget = resolve(workspaceRoot, ...parts);
  assertInsideWorkspace(workspaceRoot, unresolvedTarget);
  const targetPath = await realpath(unresolvedTarget);
  assertInsideWorkspace(workspaceRoot, targetPath);
  const canonicalRelativePath = relative(workspaceRoot, targetPath).replaceAll("\\", "/");
  validateRelativePath(canonicalRelativePath);
  return { workspaceRoot, targetPath };
}

function repositoryPath(basePath: string, name: string): string {
  return join(basePath, name).replaceAll("\\", "/");
}

export async function listRepositoryDirectory(
  input: RepositoryAccessInput,
): Promise<RepositoryDirectoryResult> {
  const { targetPath } = await resolveRepositoryPath(input);
  const targetStats = await stat(targetPath);
  if (!targetStats.isDirectory()) throw new Error("目标路径不是目录");

  const directoryEntries = await readdir(targetPath, { withFileTypes: true });
  const entries: RepositoryEntry[] = directoryEntries
    .filter(
      (entry) =>
        !isProtectedName(entry.name) &&
        !entry.isSymbolicLink() &&
        (entry.isDirectory() || entry.isFile()),
    )
    .map<RepositoryEntry>((entry) => ({
      name: entry.name,
      path: repositoryPath(input.path.trim(), entry.name),
      kind: entry.isDirectory() ? "directory" : "file",
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });

  return {
    path: input.path.trim().replaceAll("\\", "/"),
    entries: entries.slice(0, maximumDirectoryEntries),
    truncated: entries.length > maximumDirectoryEntries,
  };
}

export async function readRepositoryFile(
  input: RepositoryAccessInput,
): Promise<RepositoryFileResult> {
  const { targetPath } = await resolveRepositoryPath(input);
  const targetStats = await stat(targetPath);
  if (!targetStats.isFile()) throw new Error("目标路径不是文件");

  const bytesToRead = Math.min(targetStats.size, maximumPreviewBytes + 1);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(targetPath, "r");
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, bytesToRead, 0));
  } finally {
    await handle.close();
  }

  const preview = buffer.subarray(0, Math.min(bytesRead, maximumPreviewBytes));
  if (preview.includes(0)) throw new Error("暂不支持预览二进制文件");

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(preview, {
      stream: targetStats.size > maximumPreviewBytes,
    });
  } catch {
    throw new Error("文件不是有效的 UTF-8 文本");
  }

  return {
    path: input.path.trim().replaceAll("\\", "/"),
    content,
    size: targetStats.size,
    modifiedAt: targetStats.mtime.toISOString(),
    truncated: targetStats.size > maximumPreviewBytes,
  };
}
