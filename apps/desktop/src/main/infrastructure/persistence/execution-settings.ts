import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_TOOL_ROUNDS, parseExecutionSettings, type ExecutionSettings } from "../../../shared/execution-settings.js";

// 与模型密钥分开保存；开发版和打包版都使用各自的 Electron userData。
export function readExecutionSettings(directory: string): ExecutionSettings {
  try {
    return parseExecutionSettings(JSON.parse(readFileSync(join(directory, "execution-settings.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS };
    // 不把损坏的设置静默替换成更大的预算；用户可以打开设置重新保存。
    throw new Error("执行设置无法读取，请打开执行设置重新保存", { cause: error });
  }
}

export function writeExecutionSettings(directory: string, input: unknown): ExecutionSettings {
  const settings = parseExecutionSettings(input);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "execution-settings.json");
  // 同步临时写入后原子替换，避免并发 IPC 写入互相覆盖或留下半份 JSON。
  writeFileSync(`${path}.tmp`, JSON.stringify(settings), { encoding: "utf8", flush: true });
  renameSync(`${path}.tmp`, path);
  return settings;
}
