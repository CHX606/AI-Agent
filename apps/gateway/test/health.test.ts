import { describe, expect, it } from "vitest";

import { buildApp } from "../src/bootstrap.js";
import { MemoryTaskStore } from "../src/infrastructure/persistence/memory-task-store.js";

describe("GET /health", () => {
  it("returns the Gateway health information", async () => {
    const app = buildApp({ logger: false });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "ok",
        service: "bit-agent-gateway",
        version: "0.1.0",
      });
    } finally {
      await app.close();
    }
  });

  it("preserves the healthy response for a ready local runtime", async () => {
    const store = Object.assign(new MemoryTaskStore(), { health: async () => "ready" as const });
    const app = buildApp({ logger: false, taskStore: store });
    try {
      const response = await app.inject({ url: "/health" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok", service: "bit-agent-gateway", version: "0.1.0" });
    } finally { await app.close(); }
  });

  it.each(["unavailable", "stopped"] as const)("reports %s without treating a slow runtime as permanently stopped", async (state) => {
    const store = Object.assign(new MemoryTaskStore(), { health: async () => state });
    const app = buildApp({ logger: false, taskStore: store });
    try {
      const response = await app.inject({ url: "/health" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: "error", service: "bit-agent-gateway",
        version: "0.1.0", runtime_status: state, restart_required: state === "stopped" });
    } finally { await app.close(); }
  });
});
