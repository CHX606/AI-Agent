import { app } from "electron";
import type { CreateTaskInput, TaskInteractionInput, TaskRequestInput } from "../../shared/contracts.js";
import type { DesktopServices } from "../application/ports.js";
import { taskRequestBody } from "../application/task-input.js";
import { taskInteractionBody } from "../application/task-interaction-input.js";
import type { IpcHandler } from "./ipc-handler.js";
import { validateTaskRequest } from "./task-request.js";

export function registerTaskIpc(services: DesktopServices, handle: IpcHandler): void {
  registerTaskCreation(services, handle);
  registerTaskQueries(services, handle);
  registerTaskInteraction(services, handle);
}

function registerTaskCreation(services: DesktopServices, handle: IpcHandler): void {
  const { readExecutionSettings } = services;
  const requestJson = services.gatewayClient.request.bind(services.gatewayClient);
  handle("gateway:health", (_event, gatewayUrl: string) => requestJson(gatewayUrl, "/health"));
  handle("tasks:create", (_event, input: CreateTaskInput) => {
    const body = taskRequestBody(input, readExecutionSettings(app.getPath("userData")));
    return requestJson(input.gatewayUrl, "/v1/tasks", { method: "POST", body: JSON.stringify(body) });
  });
}

function registerTaskQueries(services: DesktopServices, handle: IpcHandler): void {
  const requestJson = services.gatewayClient.request.bind(services.gatewayClient);
  handle("tasks:get", (_event, raw: TaskRequestInput) => {
    const input = validateTaskRequest(raw);
    return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}`);
  });
  handle("tasks:result", (_event, raw: TaskRequestInput) => {
    const input = validateTaskRequest(raw);
    return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}/result`);
  });
  handle("tasks:cancel", (_event, raw: TaskRequestInput) => {
    const input = validateTaskRequest(raw);
    return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}`, { method: "DELETE" });
  });
}

function registerTaskInteraction(services: DesktopServices, handle: IpcHandler): void {
  const requestJson = services.gatewayClient.request.bind(services.gatewayClient);
  handle("tasks:interact", (_event, raw: TaskInteractionInput) => {
    const input = validateTaskRequest(raw);
    return requestJson(input.gatewayUrl, `/v1/tasks/${encodeURIComponent(input.taskId)}/interaction`, {
      method: "POST",
      body: JSON.stringify(taskInteractionBody(raw)),
    });
  });
}
