import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { publicError, type DiagnosticService } from "@bit-agent/diagnostics";
import type { TaskStore } from "../../application/ports/task-store.js";
import { terminalTaskStatuses } from "../../domain/protocol.js";

type EventRequest = FastifyRequest<{ Params: { taskId: string }; Querystring: { after?: string } }>;

async function streamEvents(request: EventRequest, reply: FastifyReply,
  taskStore: TaskStore, diagnostics: DiagnosticService, cursor: string): Promise<void> {
  try {
    while (!request.raw.aborted && !reply.raw.destroyed) {
      const events = await taskStore.readEvents(request.params.taskId, cursor, 1_000);
      for (const event of events) {
        cursor = event.id;
        reply.raw.write(`id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
      const current = await taskStore.getTask(request.params.taskId);
      if (!current || (terminalTaskStatuses.has(current.status) && events.length === 0)) break;
      if (events.length === 0) reply.raw.write(": heartbeat\n\n");
    }
  } catch (error) {
    const id = diagnostics.failure("sse_failed", error, { task_id: request.params.taskId, request_id: request.id });
    if (!reply.raw.destroyed) reply.raw.write(`event: gateway_error\ndata: ${JSON.stringify({
      message: publicError(id, "连接暂时中断，正在尝试恢复"), diagnostic_id: id })}\n\n`);
  } finally {
    if (!reply.raw.destroyed) reply.raw.end();
  }
}

export function registerTaskEvents(app: FastifyInstance, taskStore: TaskStore, diagnostics: DiagnosticService): void {
  app.get<{ Params: { taskId: string }; Querystring: { after?: string } }>("/v1/tasks/:taskId/events", async (request, reply) => {
    if (!await taskStore.getTask(request.params.taskId)) return reply.code(404).send({ error: "TASK_NOT_FOUND" });
    const lastHeader = request.headers["last-event-id"];
    const cursor = request.query.after ?? (typeof lastHeader === "string" ? lastHeader : undefined) ?? "0-0";
    if (!/^[0-9]+-[0-9]+$/u.test(cursor)) return reply.code(400).send({ error: "INVALID_CURSOR" });
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
      connection: "keep-alive", "x-accel-buffering": "no" });
    await streamEvents(request, reply, taskStore, diagnostics, cursor);
  });
}
