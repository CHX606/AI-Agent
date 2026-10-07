import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { diagnosticId, publicError, type DiagnosticService } from "@bit-agent/diagnostics";

function tokenMatches(header: string | undefined, token: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`));
}

export function registerHttpSecurity(app: FastifyInstance, diagnostics: DiagnosticService): void {
  app.setErrorHandler((error, request, reply) => {
    const err = error as Error & { statusCode?: number; userMessage?: unknown };
    const id = diagnosticId(err);
    diagnostics.record((err.statusCode ?? 500) < 500 ? "warn" : "error", "http_failed", {
      diagnostic_id: id, request_id: request.id, route: request.routeOptions.url,
      method: request.method, status_code: err.statusCode ?? 500,
    });
    const userMessage = typeof err.userMessage === "string" ? err.userMessage
      : err.statusCode === 413 ? "请求过大，请减少图片或附件的数量或大小" : undefined;
    return reply.code(err.statusCode ?? 500).send({ error: "REQUEST_FAILED", diagnostic_id: id,
      message: publicError(id, userMessage ?? "请求未完成，请检查输入和本地运行服务"),
      ...(userMessage ? { user_message: userMessage } : {}) });
  });
  app.addHook("onResponse", async (request, reply) => {
    const params = request.params as { taskId?: string; sessionId?: string } | undefined;
    diagnostics.record(reply.statusCode >= 500 ? "error" : reply.statusCode >= 400 ? "warn" : "info",
      "http_response", { request_id: request.id, method: request.method, route: request.routeOptions.url,
        task_id: params?.taskId, session_id: params?.sessionId,
        status_code: reply.statusCode, duration_ms: reply.elapsedTime });
  });
  app.addHook("onRequest", async (request, reply) => {
    const token = process.env.BIT_AGENT_GATEWAY_TOKEN;
    if (token && !tokenMatches(request.headers.authorization, token)) return reply.code(401).send({ error: "UNAUTHORIZED" });
    if (request.headers.origin) return reply.code(403).send({ error: "BROWSER_ORIGIN_NOT_ALLOWED" });
  });
}
