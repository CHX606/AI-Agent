/** “外部工具”表单的纯文本解析，不依赖页面和桌面接口，便于单独测试。 */
import type { McpServer } from "../shared/contracts.js";

/** 参数每行一个，空行忽略。 */
export function parseArgs(text: string): string[] {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

/** 环境变量每行一个 KEY=VALUE；值里可以再有等号。 */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const index = line.indexOf("=");
    const key = index > 0 ? line.slice(0, index).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/u.test(key)) throw new Error(`环境变量格式应为 KEY=VALUE：${line.slice(0, 40)}`);
    env[key] = line.slice(index + 1);
  }
  return env;
}

export function describeServer(server: McpServer): string {
  return server.type === "stdio" ? [server.command ?? "", ...(server.args ?? [])].join(" ") : server.url ?? "";
}
