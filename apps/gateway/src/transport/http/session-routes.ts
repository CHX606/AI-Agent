import type { FastifyInstance } from "fastify";
import type { TaskStore } from "../../application/ports/task-store.js";

export function registerSessionRoutes(app: FastifyInstance, taskStore: TaskStore): void {
  app.get<{ Querystring: { offset?: string; query?: string } }>("/v1/sessions", async (request, reply) => {
    const offset = Number(request.query.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return reply.code(400).send({ error: "INVALID_OFFSET" });
    const query = request.query.query ?? "";
    if (typeof query !== "string" || query.length > 200) return reply.code(400).send({ error: "INVALID_QUERY" });
    return taskStore.listSessions(offset, query.trim());
  });
  app.get<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId", async (request, reply) => {
    const session = await taskStore.getSession(request.params.sessionId);
    return session ?? reply.code(404).send({ error: "SESSION_NOT_FOUND" });
  });
  app.patch<{ Params: { sessionId: string }; Body: { multi_agent_mode?: string; title?: unknown } }>(
    "/v1/sessions/:sessionId", async (request, reply) => {
      const { multi_agent_mode: mode, title } = request.body ?? {};
      if (title !== undefined) {
        if (typeof title !== "string" || mode !== undefined) return reply.code(400).send({ error: "INVALID_TITLE" });
        return taskStore.renameSession(request.params.sessionId, title);
      }
      if (!mode || !["off", "on", "auto"].includes(mode)) return reply.code(400).send({ error: "INVALID_MODE" });
      const session = await taskStore.setSessionMode(request.params.sessionId, mode);
      return session ?? reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    });
  app.delete<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId", async request => taskStore.deleteSession(request.params.sessionId));
  app.post<{ Params: { sessionId: string }; Body: { task_id?: unknown } }>(
    "/v1/sessions/:sessionId/rewind", async (request, reply) => {
      const taskId = request.body?.task_id;
      if (typeof taskId !== "string" || !taskId) return reply.code(400).send({ error: "INVALID_TASK_ID" });
      return taskStore.rewindTurn(request.params.sessionId, taskId);
    });
}
