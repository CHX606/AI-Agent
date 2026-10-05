import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type {} from "../src/renderer/global";
import type { RendererApp } from "../src/renderer/application/context";
import { connectRuntime, internalGatewayUrl } from "../src/renderer/application/connection";

const health = vi.fn();
function fixture(address = "http://127.0.0.1:43871") {
  const connectionDot = { title: "", dataset: {} };
  const refreshSessions = vi.fn().mockResolvedValue(undefined);
  const app = { gatewayUrl: address, connectionDot, refreshSessions } as unknown as RendererApp;
  return { app, connectionDot, refreshSessions };
}

beforeEach(() => {
  health.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal("window", { bitAgent: { health, runtimeConfig: { startupError: "" } } });
});
afterEach(() => vi.unstubAllGlobals());

it("uses the managed runtime port and the established development default", () => {
  expect(internalGatewayUrl({ managed: true, gatewayUrl: "http://127.0.0.1:43871" })).toBe("http://127.0.0.1:43871");
  expect(internalGatewayUrl({ managed: false, gatewayUrl: "" })).toBe("http://127.0.0.1:3000");
});

it("never redirects an unavailable managed runtime to the development service", async () => {
  const { app, connectionDot, refreshSessions } = fixture(internalGatewayUrl({ managed: true, gatewayUrl: "" }));
  await connectRuntime(app);
  expect(health).not.toHaveBeenCalled();
  expect(refreshSessions).not.toHaveBeenCalled();
  expect(connectionDot.dataset).toEqual({ connected: "false" });
  expect(connectionDot.title).toBe("本地执行服务未就绪");
});

it("automatically connects and restores sessions without DOM connection controls", async () => {
  const { app, connectionDot, refreshSessions } = fixture();
  await connectRuntime(app);
  expect(health).toHaveBeenCalledWith(app.gatewayUrl);
  expect(refreshSessions).toHaveBeenCalledOnce();
  expect(connectionDot.dataset).toEqual({ connected: "true" });
  expect(connectionDot.title).toBe("本地服务已就绪");
});

it("reports service failure and skips session requests", async () => {
  health.mockRejectedValue(new Error("本地服务已退出"));
  const { app, connectionDot, refreshSessions } = fixture();
  await connectRuntime(app);
  expect(refreshSessions).not.toHaveBeenCalled();
  expect(connectionDot.dataset).toEqual({ connected: "false" });
  expect(connectionDot.title).toBe("本地服务已退出");
});

it("preserves healthy service status while reporting session loading errors", async () => {
  const { app, connectionDot, refreshSessions } = fixture();
  refreshSessions.mockRejectedValue(new Error("会话读取失败"));
  await connectRuntime(app);
  expect(connectionDot.dataset).toEqual({ connected: "true" });
  expect(connectionDot.title).toContain("会话列表载入失败：会话读取失败");
});

