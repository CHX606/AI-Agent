import { isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import type { DiagnosticService } from "@bit-agent/diagnostics";
import type { TaskStore } from "../../application/ports/task-store.js";

export function registerRuntimeRoutes(app: FastifyInstance, taskStore: TaskStore, diagnostics: DiagnosticService): void {
  app.get<{ Querystring: { task_id?: string } }>("/v1/diagnostics", async request => {
    const snapshot = await taskStore.diagnosticSnapshot(request.query.task_id);
    return { ...snapshot, available: diagnostics.available() && snapshot.available !== false };
  });
  app.get("/health", async (_request, reply) => {
    const health = { status: "ok", service: "bit-agent-gateway", version: "0.1.0" };
    const runtime = await taskStore.health();
    if (runtime !== "ready") return reply.code(503).send({ ...health, status: "error", runtime_status: runtime,
      restart_required: runtime === "stopped",
      message: runtime === "stopped" ? "本地执行服务已退出，请重新启动应用" : "本地执行服务暂时无法响应" });
    return health;
  });
  app.get<{ Querystring: { workspace_root?: string } }>("/v1/memories", async (request, reply) => {
    const workspaceRoot = request.query.workspace_root;
    if (workspaceRoot !== undefined && !isAbsolute(workspaceRoot)) return reply.code(400).send({ error: "INVALID_WORKSPACE_ROOT" });
    return taskStore.listMemories(workspaceRoot);
  });
  app.delete<{ Params: { memoryId: string } }>("/v1/memories/:memoryId", async request => taskStore.deleteMemory(request.params.memoryId));
}
