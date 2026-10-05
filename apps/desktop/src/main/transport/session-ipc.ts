import type { MultiAgentMode, SessionRequestInput } from "../../shared/contracts.js";
import type { DesktopServices } from "../application/ports.js";
import type { IpcHandler } from "./ipc-handler.js";

export function registerSessionIpc(services: DesktopServices, handle: IpcHandler): void {
  const requestJson = services.gatewayClient.request.bind(services.gatewayClient);
  handle("sessions:list", (_event, gatewayUrl: string, offset = 0, query = "") => {
    const search = typeof query === "string" && query.trim() ? `&query=${encodeURIComponent(query.trim().slice(0, 200))}` : "";
    return requestJson(gatewayUrl, `/v1/sessions?offset=${encodeURIComponent(String(offset))}${search}`);
  });
  handle("sessions:rename", (_event, input: SessionRequestInput & { title: string }) => {
    if (typeof input?.title !== "string") throw new Error("对话名称无效");
    return requestJson(input.gatewayUrl, `/v1/sessions/${encodeURIComponent(input.sessionId)}`, {
      method: "PATCH", body: JSON.stringify({ title: input.title }),
    });
  });
  handle("sessions:delete", (_event, input: SessionRequestInput) =>
    requestJson(input.gatewayUrl, `/v1/sessions/${encodeURIComponent(input.sessionId)}`, { method: "DELETE" }),
  );
  handle("sessions:get", (_event, input: SessionRequestInput) =>
    requestJson(input.gatewayUrl, `/v1/sessions/${encodeURIComponent(input.sessionId)}`),
  );
  handle("sessions:mode", (_event, input: SessionRequestInput & { mode: MultiAgentMode }) =>
    requestJson(input.gatewayUrl, `/v1/sessions/${encodeURIComponent(input.sessionId)}`, {
      method: "PATCH", body: JSON.stringify({ multi_agent_mode: input.mode }),
    }),
  );
}
