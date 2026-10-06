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

/** 请求头每行一个 Name: Value；值里可以再有冒号。 */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const index = line.indexOf(":");
    const name = index > 0 ? line.slice(0, index).trim() : "";
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/u.test(name)) throw new Error(`请求头格式应为 Name: Value：${line.slice(0, 40)}`);
    if (Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())) throw new Error(`请求头重复：${name}`);
    headers[name] = line.slice(index + 1).trim();
  }
  return headers;
}

export function describeServer(server: McpServer): string {
  return server.type === "stdio" ? [server.command ?? "", ...(server.args ?? [])].join(" ") : server.url ?? "";
}
