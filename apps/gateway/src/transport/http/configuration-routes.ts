import type { FastifyInstance } from "fastify";
import type { TaskStore } from "../../application/ports/task-store.js";

export function registerConfigurationRoutes(app: FastifyInstance, taskStore: TaskStore): void {
  app.post<{ Body: Record<string, unknown> }>("/v1/model", async (request, reply) => {
    if (!process.env.BIT_AGENT_GATEWAY_TOKEN) return reply.code(403).send({ error: "MANAGED_DESKTOP_REQUIRED" });
    return taskStore.configureModel(request.body);
  });
  app.post<{ Body: Record<string, unknown> }>("/v1/model/test", async (request, reply) => {
    if (!process.env.BIT_AGENT_GATEWAY_TOKEN) return reply.code(403).send({ error: "MANAGED_DESKTOP_REQUIRED" });
    return taskStore.testModel(request.body);
  });
  app.post<{ Body: { servers?: unknown } }>("/v1/mcp", async (request, reply) => {
    if (!process.env.BIT_AGENT_GATEWAY_TOKEN) return reply.code(403).send({ error: "MANAGED_DESKTOP_REQUIRED" });
    const servers = request.body?.servers;
    if (!Array.isArray(servers)) return reply.code(400).send({ error: "INVALID_SERVERS" });
    return taskStore.configureMcp(servers);
  });
  app.post<{ Body: { server?: unknown } }>("/v1/mcp/test", async (request, reply) => {
    if (!process.env.BIT_AGENT_GATEWAY_TOKEN) return reply.code(403).send({ error: "MANAGED_DESKTOP_REQUIRED" });
    const server = request.body?.server;
    if (!server || typeof server !== "object" || Array.isArray(server)) return reply.code(400).send({ error: "INVALID_SERVER" });
    return taskStore.testMcp(server as Record<string, unknown>);
  });
}
