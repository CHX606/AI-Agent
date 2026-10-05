import { delimiter, join } from "node:path";
import { prepareSandboxExecutor } from "./sandbox-executor.js";

interface GatewayEnvironmentInput {
  resources: string;
  data: string;
  userData: string;
  token: string;
  settings: Record<string, string | boolean>;
  mcp: unknown[];
}

/** 保留现有运行服务设置，沙箱路径始终来自已验证的随包资源缓存。 */
export async function createGatewayEnvironment(input: GatewayEnvironmentInput): Promise<NodeJS.ProcessEnv> {
  const { resources, data, userData, token, settings, mcp } = input;
  const sandbox = await prepareSandboxExecutor(resources, userData);
  const environment = { ...process.env };
  delete environment.BIT_AGENT_SANDBOX_HOME;
  return {
    ...environment, ELECTRON_RUN_AS_NODE: "1",
    ...(mcp.length ? { BIT_AGENT_MCP_SERVERS: JSON.stringify(mcp) } : {}),
    BIT_AGENT_GATEWAY_TOKEN: token, BIT_AGENT_PROJECT_ROOT: join(resources, "backend"),
    BIT_AGENT_PYTHON: join(resources, "python", "python.exe"), BIT_AGENT_DATA_DIR: data,
    BIT_AGENT_SANDBOX_EXECUTABLE: sandbox.executable, BIT_AGENT_SANDBOX_NODE: sandbox.node,
    BIT_AGENT_SANDBOX_BROKER: sandbox.broker,
    PATH: [join(resources, "tools"), process.env.PATH ?? ""].join(delimiter),
    ...(settings.apiKey ? { API_KEY: String(settings.apiKey), BASE_URL: String(settings.baseUrl),
      MODEL_NAME: String(settings.model), MODEL_API: settings.api === "chat_completions" ? "chat_completions" : "responses",
      AUX_MODEL_NAME: String(settings.auxModel ?? "") } : {}),
  };
}
