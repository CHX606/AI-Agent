import { isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import { createTaskBodySchema, taskInteractionSchema, terminalTaskStatuses } from "../../domain/protocol.js";
import { IMAGE_LIMITS } from "../../domain/image-input.js";
import type { TaskStore } from "../../application/ports/task-store.js";

function registerTaskWrites(app: FastifyInstance, taskStore: TaskStore): void {
  app.post("/v1/tasks", { bodyLimit: IMAGE_LIMITS.maxRequestBytes }, async (request, reply) => {
    const parsed = createTaskBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST", details: parsed.error.issues,
      user_message: "请输入任务描述或添加有效附件，并检查工作区与附件大小" });
    if (!isAbsolute(parsed.data.workspace_root)) return reply.code(400).send({ error: "INVALID_WORKSPACE_ROOT",
      message: "workspace_root 必须是绝对路径" });
    return reply.code(202).send(await taskStore.createTask(parsed.data));
  });
  app.post<{ Params: { taskId: string } }>("/v1/tasks/:taskId/interaction",
    { bodyLimit: IMAGE_LIMITS.maxRequestBytes }, async (request, reply) => {
      const parsed = taskInteractionSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "INVALID_INTERACTION", details: parsed.error.issues,
        user_message: "任务操作或附件不正确，请填写文字、选择答案或添加有效附件" });
      return taskStore.interactTask(request.params.taskId, parsed.data);
    });
}

function registerTaskReads(app: FastifyInstance, taskStore: TaskStore): void {
  app.get<{ Params: { taskId: string } }>("/v1/tasks/:taskId", async (request, reply) => {
    const task = await taskStore.getTask(request.params.taskId);
    return task ?? reply.code(404).send({ error: "TASK_NOT_FOUND" });
  });
  app.get<{ Params: { taskId: string } }>("/v1/tasks/:taskId/result", async (request, reply) => {
    const task = await taskStore.getTask(request.params.taskId);
    if (!task) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
    if (!terminalTaskStatuses.has(task.status)) return reply.code(409).send({ error: "TASK_NOT_FINISHED", status: task.status });
    return { task_id: task.task_id, status: task.status, result: task.result, error: task.error };
  });
  app.delete<{ Params: { taskId: string } }>("/v1/tasks/:taskId", async (request, reply) => {
    const cancellation = await taskStore.requestCancellation(request.params.taskId);
    if (!cancellation.found) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
    return reply.code(cancellation.changed ? 202 : 200).send(cancellation.task);
  });
}

export function registerTaskRoutes(app: FastifyInstance, taskStore: TaskStore): void {
  registerTaskWrites(app, taskStore);
  registerTaskReads(app, taskStore);
}
