import { app, net, safeStorage } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { publicError, registerSecret } from "@bit-agent/diagnostics";
import { chatModels, parseModelList } from "../../../shared/model-list.js";
import { UserFacingError } from "../../application/errors.js";
import { desktopDiagnostics } from "../observability/diagnostics.js";
import { decryptedMcpServers, mcpServerList, resolveMcpServers, writeMcpServers } from "./mcp-settings.js";

let child: ChildProcessWithoutNullStreams | null = null;
let address = "";
const token = randomBytes(32).toString("hex");
let startupError = "";
let stopping = false;

export function runtimeConfiguration() {
  // 版本号和本机用户名只用于左下角“个人中心”的显示。
  let userName = "";
  try { userName = userInfo().username; } catch { /* 取不到时界面显示默认头像 */ }
  return { managed: app.isPackaged, gatewayUrl: address, startupError, version: app.getVersion(), userName };
}

export function managedHeaders(url: string): Record<string, string> {
  // 密钥只发给本次自行启动的本地进程，用户填写别的网关地址时不携带。
  return address && url.replace(/\/$/u, "") === address ? { authorization: `Bearer ${token}` } : {};
}

function settingsPath(): string { return join(app.getPath("userData"), "model-settings.json"); }

/** responses：支持 /v1/responses 的服务；chat_completions：只提供 /v1/chat/completions 的兼容服务。 */
const modelApis = new Set(["responses", "chat_completions"]);
function modelApi(value: unknown): string {
  return typeof value === "string" && modelApis.has(value) ? value : "responses";
}

/** 每百万 tokens 的价格，只用来在界面上估算费用；留空表示不估算。 */
function price(value: unknown): string {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000) throw new UserFacingError("价格必须是 0 到 1000000 之间的数字");
  return String(number);
}

/** 已保存的价格被手工改坏时当作没填，不影响读取其他设置。 */
function storedPrice(value: unknown): string {
  try { return price(value); } catch { return ""; }
}

export function modelSettings(includeSecret = false): Record<string, string | boolean> {
  const empty = { baseUrl: "", model: "", api: "responses", configured: false };
  if (!existsSync(settingsPath())) return empty;
  let value: Record<string, string>;
  try { value = JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, string>; }
  catch (error) { return { ...empty,
    error: publicError(desktopDiagnostics().failure("settings_recovery_failed", error), "设置文件无法读取，请重新填写") }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const result: Record<string, string | boolean> = {
    baseUrl: value.baseUrl ?? "", model: value.model ?? "", api: modelApi(value.api),
    auxModel: typeof value.auxModel === "string" ? value.auxModel : "",
    // 输入框左下角可以切换的模型，换行分隔。
    models: parseModelList(value.models).join("\n"),
    inputPrice: storedPrice(value.inputPrice), outputPrice: storedPrice(value.outputPrice),
    currency: value.currency === "$" ? "$" : "¥",
    configured: Boolean(value.encryptedKey),
  };
  if (includeSecret && value.encryptedKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new UserFacingError("系统密钥保护暂不可用，不能读取模型密钥");
    result.apiKey = safeStorage.decryptString(Buffer.from(value.encryptedKey, "base64"));
  }
  return result;
}

/** 表单里的地址、模型名和密钥；密钥留空时使用已保存的那一个。 */
function modelInput(input: unknown): { baseUrl: string; model: string; apiKey: string; api: string } {
  if (!address) throw new UserFacingError("模型设置需要独立桌面运行服务；开发模式请使用环境变量");
  if (!input || typeof input !== "object") throw new UserFacingError("设置格式错误");
  const values = input as Record<string, unknown>;
  if (typeof values.baseUrl !== "string" || typeof values.model !== "string") throw new UserFacingError("请填写模型地址和名称");
  const previous = modelSettings(!(typeof values.apiKey === "string" && values.apiKey.trim()));
  const apiKey = typeof values.apiKey === "string" && values.apiKey.trim() ? values.apiKey.trim() : previous.apiKey;
  if (typeof apiKey !== "string" || !apiKey) throw new UserFacingError("请填写 API Key");
  registerSecret(apiKey);
  return { baseUrl: values.baseUrl.trim(), model: values.model.trim(), apiKey,
    api: values.api === "auto" ? "auto" : modelApi(values.api) };
}

export async function saveModelSettings(input: unknown): Promise<Record<string, string | boolean>> {
  const { baseUrl, model, apiKey, api } = modelInput(input);
  if (api === "auto") throw new UserFacingError("请先测试连接，确定接口类型后再保存");
  const values = input as Record<string, unknown>;
  const prices = { inputPrice: price(values.inputPrice), outputPrice: price(values.outputPrice),
    currency: values.currency === "$" ? "$" : "¥" };
  const auxModel = typeof values.auxModel === "string" ? values.auxModel.trim().slice(0, 200) : "";
  const models = parseModelList(values.models);
  if (!safeStorage.isEncryptionAvailable()) throw new UserFacingError("系统加密不可用，拒绝明文保存密钥");
  const response = await fetch(`${address}/v1/model`, {
    method: "POST", headers: { ...managedHeaders(address), "content-type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, model, api_key: apiKey, api, aux_model: auxModel }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new UserFacingError(`模型配置被拒绝（HTTP ${response.status}），请检查地址和字段`);
  const path = settingsPath();
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ baseUrl, model, api, auxModel, models, ...prices,
    encryptedKey: safeStorage.encryptString(apiKey).toString("base64") }), "utf8");
  renameSync(temporary, path);
  return modelSettings();
}

/** 向模型服务要一份模型列表（OpenAI 兼容的 GET /models），只留可以对话的模型；不保存。 */
export async function listProviderModels(input: unknown): Promise<string[]> {
  const { baseUrl, apiKey } = modelInput(input);
  let url: URL;
  try { url = new URL(`${baseUrl.replace(/\/+$/u, "")}/models`); } catch { throw new UserFacingError("接口地址格式不对"); }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) throw new UserFacingError("远程模型必须使用 HTTPS，本地模型允许 HTTP");
  let response: Response;
  try {
    // 用 Chromium 的网络栈，跟随系统代理设置。
    response = await net.fetch(url.toString(), {
      headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new UserFacingError("无法连接模型服务，请检查接口地址、网络或代理");
  }
  if (!response.ok) throw new UserFacingError(`模型服务没有返回模型列表（HTTP ${response.status}），可以手动填写模型名称`);
  const payload = await response.json().catch(() => ({})) as { data?: unknown };
  const ids = (Array.isArray(payload.data) ? payload.data : [])
    .map((item) => item && typeof item === "object" ? (item as { id?: unknown }).id : undefined)
    .filter((id): id is string => typeof id === "string");
  const models = chatModels(ids);
  if (!models.length) throw new UserFacingError("模型服务返回的列表里没有可以对话的模型，可以手动填写模型名称");
  return models;
}

/** 用表单当前的值真实请求一次模型；不保存、不改变正在使用的配置。 */
export async function testModelSettings(input: unknown): Promise<Record<string, unknown>> {
  const { baseUrl, model, apiKey, api } = modelInput(input);
  const response = await fetch(`${address}/v1/model/test`, {
    method: "POST", headers: { ...managedHeaders(address), "content-type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, model, api_key: apiKey, api }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new UserFacingError(`测试请求被拒绝（HTTP ${response.status}），请检查地址格式`);
  return await response.json() as Record<string, unknown>;
}

async function postManaged(path: string, body: unknown, timeout: number): Promise<Record<string, unknown>> {
  if (!address) throw new UserFacingError("外部工具需要独立桌面运行服务；开发模式请使用环境变量 BIT_AGENT_MCP_SERVERS");
  const response = await fetch(`${address}${path}`, {
    method: "POST", headers: { ...managedHeaders(address), "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new UserFacingError(typeof payload.message === "string" ? payload.message : `请求被拒绝（HTTP ${response.status}）`);
  }
  return payload;
}

export function mcpServers(): Record<string, unknown>[] { return mcpServerList(); }

/** 先让运行服务校验并启用，成功后才写入本机（环境变量加密）。 */
export async function saveMcpServers(input: unknown): Promise<Record<string, unknown>[]> {
  const { plain, encrypted } = resolveMcpServers(input);
  await postManaged("/v1/mcp", { servers: plain }, 15_000);
  writeMcpServers(encrypted);
  return mcpServerList();
}

/** 连接一个服务并列出工具；环境变量留空时用同名服务已保存的值。 */
export async function testMcpServer(input: unknown): Promise<Record<string, unknown>> {
  const { plain } = resolveMcpServers([input]);
  return postManaged("/v1/mcp/test", { server: { ...plain[0], enabled: true } }, 60_000);
}

export async function startManagedRuntime(): Promise<void> {
  if (!app.isPackaged) return;
  const diagnostics = desktopDiagnostics();
  diagnostics.record("info", "gateway_starting");
  const resources = process.resourcesPath;
  const data = process.env.BIT_AGENT_DATA_DIR ?? join(app.getPath("userData"), "runtime");
  mkdirSync(data, { recursive: true });
  let settings: Record<string, string | boolean> = {};
  try { settings = modelSettings(true); } catch (error) {
    startupError = publicError(diagnostics.failure("settings_decryption_failed", error), "已存密钥不能解密，请重新配置模型");
  }
  if (settings.apiKey) registerSecret(String(settings.apiKey));
  let mcp: unknown[] = [];
  try { mcp = decryptedMcpServers(); } catch (error) {
    diagnostics.failure("mcp_settings_decryption_failed", error);
  }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1",
    ...(mcp.length ? { BIT_AGENT_MCP_SERVERS: JSON.stringify(mcp) } : {}),
    BIT_AGENT_GATEWAY_TOKEN: token, BIT_AGENT_PROJECT_ROOT: join(resources, "backend"),
    BIT_AGENT_PYTHON: join(resources, "python", "python.exe"), BIT_AGENT_DATA_DIR: data,
    PATH: [join(resources, "tools"), process.env.PATH ?? ""].join(delimiter),
    ...(settings.apiKey ? { API_KEY: String(settings.apiKey), BASE_URL: String(settings.baseUrl),
      MODEL_NAME: String(settings.model), MODEL_API: modelApi(settings.api),
      AUX_MODEL_NAME: String(settings.auxModel ?? "") } : {}),
  };
  child = spawn(process.execPath, [join(resources, "gateway", "index.mjs")], {
    env, cwd: data, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const current = child;
  current.stderr.on("data", (chunk: Buffer) => diagnostics.record("warn", "gateway_stderr", {
    bytes: chunk.length, error_type: chunk.toString().match(/\b([A-Za-z]+(?:Error|Exception)):/u)?.[1],
  }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("本地运行服务启动超时")), 30_000);
    const lines = createInterface({ input: current.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { gatewayUrl?: string };
        if (message.gatewayUrl && /^http:\/\/127\.0\.0\.1:\d+$/u.test(message.gatewayUrl)) {
          address = message.gatewayUrl;
          diagnostics.record("info", "gateway_ready");
          clearTimeout(timer);
          resolve();
        }
      } catch { /* 非就绪消息不进入界面。 */ }
    });
    current.once("error", (error) => { clearTimeout(timer); reject(error); });
    current.once("exit", (code, signal) => {
      clearTimeout(timer);
      diagnostics.record(stopping && code === 0 ? "info" : "error", "gateway_exit", {
        exit_code: code, signal, reason: stopping ? "shutdown" : "unexpected",
      });
      if (!address) reject(new Error("本地服务启动失败"));
      address = "";
    });
  });
}

export async function stopManagedRuntime(): Promise<void> {
  stopping = true;
  if (!child || child.exitCode !== null) return;
  const current = child;
  child = null;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { current.kill(); resolve(); }, 40_000);
    current.once("exit", () => { clearTimeout(timer); resolve(); });
    current.stdin.end();
  });
}
