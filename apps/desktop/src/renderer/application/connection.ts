import { errorText } from "../dom";
import type { RendererApp } from "./context";

/** 网关由桌面程序管理；开发环境使用现有本地服务默认地址。 */
export function internalGatewayUrl(config: { managed: boolean; gatewayUrl: string }): string {
  const address = config.gatewayUrl.trim();
  return config.managed ? address : address || "http://127.0.0.1:3000";
}

function setConnection(app: RendererApp, connected: "pending" | "true" | "false", message: string): void {
  app.connectionDot.title = message;
  app.connectionDot.dataset.connected = connected;
}

export async function connectRuntime(app: RendererApp): Promise<void> {
  setConnection(app, "pending", "正在准备本地服务…");
  try {
    if (!app.gatewayUrl) throw new Error(window.bitAgent.runtimeConfig.startupError || "本地执行服务未就绪");
    await window.bitAgent.health(app.gatewayUrl);
  } catch (error) {
    setConnection(app, "false", errorText(error, "本地服务连接失败"));
    return;
  }
  setConnection(app, "true", "本地服务已就绪");
  try {
    await app.refreshSessions();
  } catch (error) {
    app.connectionDot.title = `本地服务已就绪，但会话列表载入失败：${errorText(error)}`;
  }
}

