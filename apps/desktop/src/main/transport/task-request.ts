import type { TaskRequestInput } from "../../shared/contracts.js";
import { normalizeGatewayUrl } from "../../shared/gateway-url.js";

export function validateTaskRequest(input: TaskRequestInput): TaskRequestInput {
  if (!input || typeof input.taskId !== "string" || !input.taskId.trim()) {
    throw new Error("taskId 不能为空");
  }
  return { gatewayUrl: normalizeGatewayUrl(input.gatewayUrl), taskId: input.taskId.trim() };
}
