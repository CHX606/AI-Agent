import type { MemoryDeleteInput, MemoryListInput } from "../../shared/contracts.js";
import type { DesktopServices } from "../application/ports.js";
import type { IpcHandler } from "./ipc-handler.js";

export function registerMemoryIpc(services: DesktopServices, handle: IpcHandler): void {
  const requestJson = services.gatewayClient.request.bind(services.gatewayClient);
  handle("memories:list", (_event, input: MemoryListInput) => {
    const root = typeof input?.workspaceRoot === "string" ? input.workspaceRoot.trim() : "";
    return requestJson(input.gatewayUrl,
      `/v1/memories${root ? `?workspace_root=${encodeURIComponent(root)}` : ""}`);
  });
  handle("memories:delete", (_event, input: MemoryDeleteInput) => {
    if (typeof input?.memoryId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.memoryId)) {
      throw new Error("记忆编号无效");
    }
    return requestJson(input.gatewayUrl, `/v1/memories/${encodeURIComponent(input.memoryId)}`, { method: "DELETE" });
  });
}
