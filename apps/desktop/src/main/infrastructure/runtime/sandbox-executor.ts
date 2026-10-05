import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseSandboxManifest, sandboxFiles, sandboxVersion } from "./sandbox-manifest.js";

export interface SandboxExecutor { executable: string; node: string; broker: string }

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function regularFile(path: string): Promise<boolean> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`沙箱执行文件不能是目录或链接：${path}`);
  return true;
}

async function matches(path: string, expected: string): Promise<boolean> {
  return await regularFile(path) && await fileHash(path) === expected;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`沙箱私有目录不能是链接：${path}`);
}

/** 同版本已校验缓存不重复复制；新文件先完整校验，再原子替换。 */
async function cacheFile(source: string, target: string, digest: string): Promise<void> {
  if (await matches(target, digest)) return;
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    if (!await matches(temporary, digest)) throw new Error(`复制后的沙箱文件 SHA256 校验失败：${source}`);
    try { await rename(temporary, target); }
    catch (error) {
      // 另一启动进程已完成同一份缓存时，可以复用它的完整且已校验文件。
      if (!await matches(target, digest)) throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 这里只准备官方 SDK 执行文件缓存，不执行初始化或任务命令。 */
export async function prepareSandboxExecutor(resources: string, userData: string): Promise<SandboxExecutor> {
  const bundled = join(resources, "sandbox");
  const manifest = parseSandboxManifest(JSON.parse(await readFile(join(bundled, "sandbox-manifest.json"), "utf8")));
  for (const name of sandboxFiles) {
    if (!await matches(join(bundled, name), manifest.files[name])) {
      throw new Error(`随包沙箱执行器 SHA256 校验失败：${name}，拒绝启动本地服务`);
    }
  }
  const base = join(userData, "sandbox-executor");
  const cache = join(base, sandboxVersion);
  await privateDirectory(base);
  await privateDirectory(cache);
  for (const name of sandboxFiles) {
    await cacheFile(join(bundled, name), join(cache, name), manifest.files[name]);
  }
  return { executable: join(cache, "srt-win.exe"), node: join(cache, "node.exe"), broker: join(cache, "sandbox-runner.mjs") };
}
