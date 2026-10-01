import { app, safeStorage } from "electron";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerSecret } from "@bit-agent/diagnostics";
import { UserFacingError } from "../../application/errors.js";

/** 外部工具（MCP Server）配置。环境变量里常有令牌，值用 Windows 系统加密保存，页面只看得到变量名。 */
export interface McpServerInput {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled?: boolean;
  auto_approve?: boolean;
  /** 新填写的环境变量；不传时沿用同名服务已保存的值。 */
  env?: Record<string, string>;
}

interface StoredServer extends Omit<McpServerInput, "env"> { env: Record<string, string> }

function settingsPath(): string { return join(app.getPath("userData"), "mcp-servers.json"); }

function stored(): StoredServer[] {
  if (!existsSync(settingsPath())) return [];
  try {
    const value = JSON.parse(readFileSync(settingsPath(), "utf8")) as { servers?: unknown };
    return Array.isArray(value.servers) ? value.servers as StoredServer[] : [];
  } catch { return []; }
}

function decrypt(server: StoredServer): McpServerInput {
  const env = Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => {
    const plain = safeStorage.decryptString(Buffer.from(value, "base64"));
    registerSecret(plain);
    return [key, plain];
  }));
  return { ...server, ...(server.type === "stdio" ? { env } : {}) };
}

/** 页面看到的列表：环境变量只给出名字。 */
export function mcpServerList(): Record<string, unknown>[] {
  return stored().map(({ env, ...server }) => ({ ...server, envKeys: Object.keys(env ?? {}) }));
}

/** 运行服务需要的完整配置（含解密后的环境变量）。系统加密不可用时不交出带密钥的服务。 */
export function decryptedMcpServers(): McpServerInput[] {
  if (!safeStorage.isEncryptionAvailable()) return stored().filter((server) => !Object.keys(server.env ?? {}).length);
  return stored().map(decrypt);
}

/** 把页面提交的列表补上已保存的密钥，得到交给运行服务的完整配置和要写入磁盘的加密版本。 */
export function resolveMcpServers(input: unknown): { plain: McpServerInput[]; encrypted: StoredServer[] } {
  if (!Array.isArray(input)) throw new UserFacingError("外部工具配置格式错误");
  const previous = new Map(stored().map((server) => [server.name, server]));
  const plain: McpServerInput[] = [];
  const encrypted: StoredServer[] = [];
  for (const raw of input as McpServerInput[]) {
    if (!raw || typeof raw !== "object" || typeof raw.name !== "string") throw new UserFacingError("外部工具配置格式错误");
    const { env, ...rest } = raw;
    const server = { ...rest } as StoredServer & { envKeys?: unknown };
    delete server.envKeys;
    let secrets: Record<string, string>;
    if (env && typeof env === "object") {
      if (Object.keys(env).length && !safeStorage.isEncryptionAvailable()) throw new UserFacingError("系统加密不可用，拒绝明文保存环境变量");
      secrets = Object.fromEntries(Object.entries(env).map(([key, value]) => {
        if (typeof value !== "string") throw new UserFacingError(`环境变量 ${key} 的值必须是文字`);
        registerSecret(value);
        return [key, safeStorage.encryptString(value).toString("base64")];
      }));
    } else {
      secrets = previous.get(raw.name)?.env ?? {};
    }
    encrypted.push({ ...server, env: raw.type === "stdio" ? secrets : {} });
    plain.push(decrypt({ ...server, env: raw.type === "stdio" ? secrets : {} }));
  }
  return { plain, encrypted };
}

export function writeMcpServers(servers: StoredServer[]): void {
  const temporary = `${settingsPath()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ servers }), "utf8");
  renameSync(temporary, settingsPath());
}
