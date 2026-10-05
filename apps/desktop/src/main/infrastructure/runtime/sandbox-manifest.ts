export const sandboxVersion = "0.0.78";
export const sandboxFiles = [
  "node.exe", "sandbox-runner.mjs", "srt-win.exe",
] as const;
export type SandboxFile = typeof sandboxFiles[number];
export interface SandboxManifest {
  version: typeof sandboxVersion;
  files: Record<SandboxFile, string>;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 只允许随程序固定分发的三个执行文件；清单不能选择其他路径或版本。 */
export function parseSandboxManifest(value: unknown): SandboxManifest {
  if (!record(value) || value.version !== sandboxVersion
    || Object.keys(value).sort().join(",") !== "files,version" || !record(value.files)) {
    throw new Error("随包沙箱清单格式或版本不正确，拒绝启动本地服务");
  }
  const entries = value.files;
  if (Object.keys(entries).sort().join(",") !== [...sandboxFiles].sort().join(",")) {
    throw new Error("随包沙箱清单必须只包含固定的三个执行文件");
  }
  const files = {} as Record<SandboxFile, string>;
  for (const name of sandboxFiles) {
    const digest = entries[name];
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/iu.test(digest)) {
      throw new Error(`随包沙箱 SHA256 格式不正确：${name}`);
    }
    files[name] = digest.toLowerCase();
  }
  return { version: sandboxVersion, files };
}
