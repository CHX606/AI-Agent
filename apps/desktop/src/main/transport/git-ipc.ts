import type { GitCommitInput, TaskRequestInput } from "../../shared/contracts.js";
import type { DesktopServices } from "../application/ports.js";
import type { IpcHandler } from "./ipc-handler.js";
import { validateTaskRequest } from "./task-request.js";

export function registerGitIpc(services: DesktopServices, handle: IpcHandler): void {
  registerChangeReview(services, handle);
  registerGitOperations(services, handle);
}

function registerChangeReview(services: DesktopServices, handle: IpcHandler): void {
  const requestJson = services.gatewayClient.request.bind(services.gatewayClient);
  handle("changes:get", (_event, raw: TaskRequestInput) => {
    const input = validateTaskRequest(raw);
    return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}/changes`);
  });
  handle("changes:review", (_event, raw: TaskRequestInput & { changeId: string; action: string }) => {
    const input = validateTaskRequest(raw);
    return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}/changes`, {
      method: "POST", body: JSON.stringify({ change_id: raw.changeId, action: raw.action }),
    });
  });
}

function registerGitOperations(services: DesktopServices, handle: IpcHandler): void {
  const requestJson = services.gatewayClient.request.bind(services.gatewayClient);
  handle("git:status", (_event, raw: TaskRequestInput) => {
    const input = validateTaskRequest(raw);
    return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}/git`);
  });
  handle("git:message", (_event, raw: TaskRequestInput) => {
    const input = validateTaskRequest(raw);
    return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}/git/message`,
      { method: "POST", body: "{}" });
  });
  handle("git:commit", (_event, raw: GitCommitInput) => {
    const input = validateTaskRequest(raw);
    if (typeof raw.message !== "string" || (raw.branch !== undefined && typeof raw.branch !== "string")) {
      throw new Error("提交信息格式错误");
    }
    return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}/git/commit`, {
      method: "POST", body: JSON.stringify({ message: raw.message, ...(raw.branch ? { branch: raw.branch } : {}) }),
    });
  });
}
