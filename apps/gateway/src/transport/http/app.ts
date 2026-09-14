import Fastify, { LogController, type FastifyInstance, type FastifyBaseLogger } from "fastify";
import { isAbsolute } from "node:path";

import {
    createTaskBodySchema,
    taskInteractionSchema,
    terminalTaskStatuses,
} from "../../domain/protocol.js";
import type { TaskStore } from "../../application/ports/task-store.js";
import { diagnosticId, publicError, type DiagnosticService } from "@bit-agent/diagnostics";

export interface BuildAppOptions {
    logger?: boolean;
    taskStore: TaskStore;
    diagnostics: DiagnosticService;
}

export function createHttpApp(
    options: BuildAppOptions,
): FastifyInstance {
    const { taskStore, diagnostics } = options;
    const app = Fastify({
        ...(options.logger === false ? { logger: false } : { loggerInstance: diagnostics.logger as FastifyBaseLogger }),
        logController: new LogController({ disableRequestLogging: true }),
        genReqId: request => {
            const id = request.headers["x-request-id"];
            return typeof id === "string" && /^D-[a-f0-9]{16}$/u.test(id) ? id : diagnosticId();
        },
    });

    app.setErrorHandler((error, request, reply) => {
        const err = error as Error & { statusCode?: number };
        const id = diagnosticId(err);
        diagnostics.record((err.statusCode ?? 500) < 500 ? "warn" : "error", "http_failed", {
            diagnostic_id: id,
            request_id: request.id, route: request.routeOptions.url, method: request.method,
            status_code: err.statusCode ?? 500,
        });
        return reply.code(err.statusCode ?? 500).send({ error: "REQUEST_FAILED", diagnostic_id: id,
            message: publicError(id, "请求未完成，请检查输入和本地运行服务") });
    });
    app.addHook("onResponse", async (request, reply) => {
        const params = request.params as { taskId?: string; sessionId?: string } | undefined;
        diagnostics.record(reply.statusCode >= 500 ? "error" : reply.statusCode >= 400 ? "warn" : "info",
            "http_response", { request_id: request.id, method: request.method, route: request.routeOptions.url,
                task_id: params?.taskId, session_id: params?.sessionId,
                status_code: reply.statusCode, duration_ms: reply.elapsedTime });
    });

    app.get<{ Querystring: { task_id?: string } }>("/v1/diagnostics", async (request, reply) => {
        if (!taskStore.diagnosticSnapshot) return reply.code(501).send({ error: "LOCAL_RUNTIME_REQUIRED" });
        const snapshot = await taskStore.diagnosticSnapshot(request.query.task_id);
        return { ...snapshot, available: diagnostics.available() && snapshot.available !== false };
    });

    app.get("/health", async (_request, reply) => {
        const health = {
            status: "ok",
            service: "bit-agent-gateway",
            version: "0.1.0",
        };
        const runtime = await taskStore.health?.();
        if (runtime && runtime !== "ready") {
            return reply.code(503).send({ ...health, status: "error", runtime_status: runtime,
                restart_required: runtime === "stopped",
                message: runtime === "stopped" ? "本地执行服务已退出，请重新启动应用" : "本地执行服务暂时无法响应" });
        }
        return health;
    });

    app.addHook("onRequest", async (request, reply) => {
        if (process.env.BIT_AGENT_GATEWAY_TOKEN && request.headers.authorization !== `Bearer ${process.env.BIT_AGENT_GATEWAY_TOKEN}`) {
            return reply.code(401).send({ error: "UNAUTHORIZED" });
        }
        if (request.headers.origin) return reply.code(403).send({ error: "BROWSER_ORIGIN_NOT_ALLOWED" });
    });

    app.get<{ Querystring: { offset?: string } }>("/v1/sessions", async (request, reply) => {
        if (!taskStore.listSessions) return reply.code(501).send({ error: "LOCAL_SESSIONS_UNAVAILABLE" });
        const offset = Number(request.query.offset ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) return reply.code(400).send({ error: "INVALID_OFFSET" });
        return taskStore.listSessions(offset);
    });

    app.get<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId", async (request, reply) => {
        if (!taskStore.getSession) return reply.code(501).send({ error: "LOCAL_SESSIONS_UNAVAILABLE" });
        const session = await taskStore.getSession(request.params.sessionId);
        return session ?? reply.code(404).send({ error: "SESSION_NOT_FOUND" });
    });

    app.patch<{ Params: { sessionId: string }; Body: { multi_agent_mode?: string } }>(
        "/v1/sessions/:sessionId", async (request, reply) => {
            if (!taskStore.setSessionMode) return reply.code(501).send({ error: "LOCAL_SESSIONS_UNAVAILABLE" });
            const mode = request.body?.multi_agent_mode;
            if (!mode || !["off", "on", "auto"].includes(mode)) return reply.code(400).send({ error: "INVALID_MODE" });
            const session = await taskStore.setSessionMode(request.params.sessionId, mode);
            return session ?? reply.code(404).send({ error: "SESSION_NOT_FOUND" });
        },
    );

    app.post<{ Body: Record<string, unknown> }>("/v1/model", async (request, reply) => {
        // 模型密钥只接受桌面主进程的认证请求，不开放给旧的无认证网关。
        if (!process.env.BIT_AGENT_GATEWAY_TOKEN || !taskStore.configureModel) {
            return reply.code(403).send({ error: "MANAGED_DESKTOP_REQUIRED" });
        }
        return taskStore.configureModel(request.body);
    });
    app.get<{ Params: { taskId: string } }>("/v1/tasks/:taskId/changes", async (request, reply) => {
        if (!taskStore.getChanges) return reply.code(501).send({ error: "LOCAL_RUNTIME_REQUIRED" });
        return taskStore.getChanges(request.params.taskId);
    });
    app.post<{ Params: { taskId: string }; Body: { change_id?: string; action?: string } }>(
        "/v1/tasks/:taskId/changes", async (request, reply) => {
            if (!taskStore.reviewChange) return reply.code(501).send({ error: "LOCAL_RUNTIME_REQUIRED" });
            if (!request.body || typeof request.body.change_id !== "string" || !["accept", "undo"].includes(request.body.action ?? "")) {
                return reply.code(400).send({ error: "INVALID_REVIEW" });
            }
            return taskStore.reviewChange(request.params.taskId, request.body.change_id, request.body.action!);
        },
    );

    app.post("/v1/tasks", async (request, reply) => {
        const parsed = createTaskBodySchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "INVALID_REQUEST",
                details: parsed.error.issues,
            });
        }
        if (!isAbsolute(parsed.data.workspace_root)) {
            return reply.code(400).send({
                error: "INVALID_WORKSPACE_ROOT",
                message: "workspace_root 必须是绝对路径",
            });
        }
        if (!taskStore.getSession && (parsed.data.session_id || parsed.data.multi_agent_mode || parsed.data.permission_mode)) {
            return reply.code(400).send({
                error: "LOCAL_RUNTIME_REQUIRED", message: "会话恢复和三档模式需要默认的 local 运行方式",
            });
        }
        const task = await taskStore.createTask(parsed.data);
        return reply.code(202).send(task);
    });

    app.post<{ Params: { taskId: string } }>("/v1/tasks/:taskId/interaction", async (request, reply) => {
        if (!taskStore.interactTask) return reply.code(501).send({ error: "LOCAL_INTERACTION_REQUIRED" });
        const parsed = taskInteractionSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "INVALID_INTERACTION", details: parsed.error.issues });
        return taskStore.interactTask(request.params.taskId, parsed.data);
    });

    app.get<{ Params: { taskId: string } }>("/v1/tasks/:taskId", async (request, reply) => {
        const task = await taskStore.getTask(request.params.taskId);
        if (!task) {
            return reply.code(404).send({ error: "TASK_NOT_FOUND" });
        }
        return task;
    });

    app.get<{ Params: { taskId: string } }>(
        "/v1/tasks/:taskId/result",
        async (request, reply) => {
            const task = await taskStore.getTask(request.params.taskId);
            if (!task) {
                return reply.code(404).send({ error: "TASK_NOT_FOUND" });
            }
            if (!terminalTaskStatuses.has(task.status)) {
                return reply.code(409).send({
                    error: "TASK_NOT_FINISHED",
                    status: task.status,
                });
            }
            return {
                task_id: task.task_id,
                status: task.status,
                result: task.result,
                error: task.error,
            };
        },
    );

    app.delete<{ Params: { taskId: string } }>(
        "/v1/tasks/:taskId",
        async (request, reply) => {
            const cancellation = await taskStore.requestCancellation(request.params.taskId);
            if (!cancellation.found) {
                return reply.code(404).send({ error: "TASK_NOT_FOUND" });
            }
            return reply.code(cancellation.changed ? 202 : 200).send(cancellation.task);
        },
    );

    app.get<{
        Params: { taskId: string };
        Querystring: { after?: string };
    }>("/v1/tasks/:taskId/events", async (request, reply) => {
        const task = await taskStore.getTask(request.params.taskId);
        if (!task) {
            return reply.code(404).send({ error: "TASK_NOT_FOUND" });
        }

        const lastHeader = request.headers["last-event-id"];
        let cursor = request.query.after
            ?? (typeof lastHeader === "string" ? lastHeader : undefined)
            ?? "0-0";
        if (!/^[0-9]+-[0-9]+$/u.test(cursor)) return reply.code(400).send({ error: "INVALID_CURSOR" });
        reply.hijack();
        reply.raw.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
        });

        try {
            while (!request.raw.aborted && !reply.raw.destroyed) {
                const events = await taskStore.readEvents(request.params.taskId, cursor, 1_000);
                for (const event of events) {
                    cursor = event.id;
                    reply.raw.write(
                        `id: ${event.id}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event.data)}\n\n`,
                    );
                }
                const current = await taskStore.getTask(request.params.taskId);
                if (!current || (terminalTaskStatuses.has(current.status) && events.length === 0)) {
                    break;
                }
                if (events.length === 0) {
                    reply.raw.write(": heartbeat\n\n");
                }
            }
        } catch (error) {
            const id = diagnostics.failure("sse_failed", error, { task_id: request.params.taskId, request_id: request.id });
            if (!reply.raw.destroyed) {
                reply.raw.write(
                    `event: gateway_error\ndata: ${JSON.stringify({ message: publicError(id, "连接暂时中断，正在尝试恢复"), diagnostic_id: id })}\n\n`,
                );
            }
        } finally {
            if (!reply.raw.destroyed) {
                reply.raw.end();
            }
        }
    });

    app.addHook("onClose", async () => {
        await taskStore.close?.();
    });

    return app;
}
