import { app, safeStorage } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { publicError, registerSecret } from "@bit-agent/diagnostics";
import { desktopDiagnostics } from "../observability/diagnostics.js";

let child: ChildProcessWithoutNullStreams | null = null;
let address = "";
const token = randomBytes(32).toString("hex");
let startupError = "";
let stopping = false;

export function runtimeConfiguration() {
  return { managed: app.isPackaged, gatewayUrl: address, startupError };
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
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000) throw new Error("价格必须是 0 到 1000000 之间的数字");
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
    inputPrice: storedPrice(value.inputPrice), outputPrice: storedPrice(value.outputPrice),
    currency: value.currency === "$" ? "$" : "¥",
    configured: Boolean(value.encryptedKey),
  };
  if (includeSecret && value.encryptedKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统密钥保护暂不可用，不能读取模型密钥");
    result.apiKey = safeStorage.decryptString(Buffer.from(value.encryptedKey, "base64"));
  }
  return result;
}

/** 表单里的地址、模型名和密钥；密钥留空时使用已保存的那一个。 */
function modelInput(input: unknown): { baseUrl: string; model: string; apiKey: string; api: string } {
  if (!address) throw new Error("模型设置需要独立桌面运行服务；开发模式请使用环境变量");
  if (!input || typeof input !== "object") throw new Error("设置格式错误");
  const values = input as Record<string, unknown>;
  if (typeof values.baseUrl !== "string" || typeof values.model !== "string") throw new Error("请填写模型地址和名称");
  const previous = modelSettings(!(typeof values.apiKey === "string" && values.apiKey.trim()));
  const apiKey = typeof values.apiKey === "string" && values.apiKey.trim() ? values.apiKey.trim() : previous.apiKey;
  if (typeof apiKey !== "string" || !apiKey) throw new Error("请填写 API Key");
  registerSecret(apiKey);
  return { baseUrl: values.baseUrl.trim(), model: values.model.trim(), apiKey,
    api: values.api === "auto" ? "auto" : modelApi(values.api) };
}

export async function saveModelSettings(input: unknown): Promise<Record<string, string | boolean>> {
  const { baseUrl, model, apiKey, api } = modelInput(input);
  if (api === "auto") throw new Error("请先测试连接，确定接口类型后再保存");
  const values = input as Record<string, unknown>;
  const prices = { inputPrice: price(values.inputPrice), outputPrice: price(values.outputPrice),
    currency: values.currency === "$" ? "$" : "¥" };
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统加密不可用，拒绝明文保存密钥");
  const response = await fetch(`${address}/v1/model`, {
    method: "POST", headers: { ...managedHeaders(address), "content-type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, model, api_key: apiKey, api }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`模型配置被拒绝（HTTP ${response.status}），请检查地址和字段`);
  const path = settingsPath();
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ baseUrl, model, api, ...prices,
    encryptedKey: safeStorage.encryptString(apiKey).toString("base64") }), "utf8");
  renameSync(temporary, path);
  return modelSettings();
}

/** 用表单当前的值真实请求一次模型；不保存、不改变正在使用的配置。 */
export async function testModelSettings(input: unknown): Promise<Record<string, unknown>> {
  const { baseUrl, model, apiKey, api } = modelInput(input);
  const response = await fetch(`${address}/v1/model/test`, {
    method: "POST", headers: { ...managedHeaders(address), "content-type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, model, api_key: apiKey, api }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`测试请求被拒绝（HTTP ${response.status}），请检查地址格式`);
  return await response.json() as Record<string, unknown>;
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
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1",
    BIT_AGENT_GATEWAY_TOKEN: token, BIT_AGENT_PROJECT_ROOT: join(resources, "backend"),
    BIT_AGENT_PYTHON: join(resources, "python", "python.exe"), BIT_AGENT_DATA_DIR: data,
    PATH: [join(resources, "tools"), process.env.PATH ?? ""].join(delimiter),
    ...(settings.apiKey ? { API_KEY: String(settings.apiKey), BASE_URL: String(settings.baseUrl),
      MODEL_NAME: String(settings.model), MODEL_API: modelApi(settings.api) } : {}),
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
