import type { FastifyInstance } from "fastify";
import type { TaskStore } from "../../application/ports/task-store.js";

export function registerChangeRoutes(app: FastifyInstance, taskStore: TaskStore): void {
  app.get<{ Params: { taskId: string } }>("/v1/tasks/:taskId/changes", async request => taskStore.getChanges(request.params.taskId));
  app.post<{ Params: { taskId: string }; Body: { change_id?: string; action?: string } }>(
    "/v1/tasks/:taskId/changes", async (request, reply) => {
      if (!request.body || typeof request.body.change_id !== "string" || !["accept", "undo"].includes(request.body.action ?? "")) {
        return reply.code(400).send({ error: "INVALID_REVIEW" });
      }
      return taskStore.reviewChange(request.params.taskId, request.body.change_id, request.body.action!);
    });
  app.get<{ Params: { taskId: string } }>("/v1/tasks/:taskId/git", async request => taskStore.gitStatus(request.params.taskId));
  app.post<{ Params: { taskId: string } }>("/v1/tasks/:taskId/git/message", async request => taskStore.suggestCommitMessage(request.params.taskId));
  app.post<{ Params: { taskId: string }; Body: { message?: unknown; branch?: unknown } }>(
    "/v1/tasks/:taskId/git/commit", async (request, reply) => {
      const { message, branch } = request.body ?? {};
      if (typeof message !== "string" || (branch !== undefined && branch !== null && typeof branch !== "string")) {
        return reply.code(400).send({ error: "INVALID_COMMIT" });
      }
      return taskStore.commitChanges(request.params.taskId,
        { message, ...(typeof branch === "string" && branch ? { branch } : {}) });
    });
}
