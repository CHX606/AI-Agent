import { app, safeStorage } from "electron";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerSecret } from "@bit-agent/diagnostics";
import { UserFacingError } from "../../application/errors.js";

/**
 * 外部工具（MCP Server）配置。stdio 的环境变量和 http 的请求头里常有令牌，
 * 值用 Windows 系统加密保存，页面只看得到名字。
 */
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
  /** 新填写的请求头；不传时沿用同名服务已保存的值。 */
  headers?: Record<string, string>;
}

interface StoredServer extends Omit<McpServerInput, "env" | "headers"> {
  env: Record<string, string>;
  headers?: Record<string, string>;
}

/** 每种类型加密保存的那一组值。 */
function secretField(type: unknown): "env" | "headers" { return type === "http" ? "headers" : "env"; }

function settingsPath(): string { return join(app.getPath("userData"), "mcp-servers.json"); }

function stored(): StoredServer[] {
  if (!existsSync(settingsPath())) return [];
  try {
    const value = JSON.parse(readFileSync(settingsPath(), "utf8")) as { servers?: unknown };
    return Array.isArray(value.servers) ? value.servers as StoredServer[] : [];
  } catch { return []; }
}

function secretsOf(server: StoredServer): Record<string, string> { return server[secretField(server.type)] ?? {}; }

function decrypt(server: StoredServer): McpServerInput {
  const { env: _env, headers: _headers, ...rest } = server;
  const values = Object.fromEntries(Object.entries(secretsOf(server)).map(([key, value]) => {
    const plain = safeStorage.decryptString(Buffer.from(value, "base64"));
    registerSecret(plain);
    return [key, plain];
  }));
  return { ...rest, [secretField(server.type)]: values };
}

/** 页面看到的列表：环境变量和请求头只给出名字。 */
export function mcpServerList(): Record<string, unknown>[] {
  return stored().map(({ env, headers, ...server }) => ({
    ...server, envKeys: Object.keys(env ?? {}), headerKeys: Object.keys(headers ?? {}),
  }));
}

/** 运行服务需要的完整配置（含解密后的值）。系统加密不可用时不交出带密钥的服务。 */
export function decryptedMcpServers(): McpServerInput[] {
  if (!safeStorage.isEncryptionAvailable()) return stored().filter((server) => !Object.keys(secretsOf(server)).length);
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
    if (raw.name.toLowerCase() === "browser") throw new UserFacingError("browser 是内置浏览器使用的名字，请换一个服务名");
    const field = secretField(raw.type);
    const label = field === "env" ? "环境变量" : "请求头";
    const { env: _env, headers: _headers, ...rest } = raw;
    const server = { ...rest } as StoredServer & { envKeys?: unknown; headerKeys?: unknown };
    delete server.envKeys;
    delete server.headerKeys;
    const fresh = raw[field];
    let secrets: Record<string, string>;
    if (fresh && typeof fresh === "object") {
      if (Object.keys(fresh).length && !safeStorage.isEncryptionAvailable()) throw new UserFacingError(`系统加密不可用，拒绝明文保存${label}`);
      secrets = Object.fromEntries(Object.entries(fresh).map(([key, value]) => {
        if (typeof value !== "string") throw new UserFacingError(`${label} ${key} 的值必须是文字`);
        registerSecret(value);
        return [key, safeStorage.encryptString(value).toString("base64")];
      }));
    } else {
      const old = previous.get(raw.name);
      secrets = old && secretField(old.type) === field ? secretsOf(old) : {};
    }
    const entry: StoredServer = field === "env" ? { ...server, env: secrets } : { ...server, env: {}, headers: secrets };
    encrypted.push(entry);
    plain.push(decrypt(entry));
  }
  return { plain, encrypted };
}

export function writeMcpServers(servers: StoredServer[]): void {
  const temporary = `${settingsPath()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ servers }), "utf8");
  renameSync(temporary, settingsPath());
}
