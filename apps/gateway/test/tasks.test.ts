import { describe, expect, it } from "vitest";

import { buildApp } from "../src/bootstrap.js";
import { MemoryTaskStore } from "../src/infrastructure/persistence/memory-task-store.js";

describe("task API", () => {
  it.each([undefined, 1, 25, 1000])("preserves a configured round limit (%s)", async (limit) => {
    const app = buildApp({ logger: false, taskStore: new MemoryTaskStore() });
    try {
      const created = await app.inject({ method: "POST", url: "/v1/tasks", payload: {
        objective: "inspect", workspace_root: "D:\\workspace",
        ...(limit === undefined ? {} : { max_tool_rounds: limit }),
      } });
      expect(created.statusCode).toBe(202);
      const task = created.json();
      expect(task.max_tool_rounds).toBe(limit ?? 100);
      const fetched = await app.inject({ method: "GET", url: `/v1/tasks/${task.task_id}` });
      expect(fetched.json().max_tool_rounds).toBe(limit ?? 100);
    } finally { await app.close(); }
  });

  it.each([0, -1, 1.5, 1001, "100", null, true])("rejects an invalid round limit (%s)", async (limit) => {
    const app = buildApp({ logger: false, taskStore: new MemoryTaskStore() });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/tasks", payload: {
        objective: "inspect", workspace_root: "D:\\workspace", max_tool_rounds: limit,
      } });
      expect(response.statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("creates, reads, and cancels a queued task", async () => {
    const store = new MemoryTaskStore();
    const app = buildApp({ logger: false, taskStore: store });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        payload: {
          objective: "修复失败测试",
          workspace_root: "D:\\workspace\\demo",
        },
      });
      expect(created.statusCode).toBe(202);
      const task = created.json();
      expect(task.status).toBe("QUEUED");

      const fetched = await app.inject({
        method: "GET",
        url: `/v1/tasks/${task.task_id}`,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json()).toEqual(task);

      const pendingResult = await app.inject({
        method: "GET",
        url: `/v1/tasks/${task.task_id}/result`,
      });
      expect(pendingResult.statusCode).toBe(409);

      const cancelled = await app.inject({
        method: "DELETE",
        url: `/v1/tasks/${task.task_id}`,
      });
      expect(cancelled.statusCode).toBe(202);
      expect(cancelled.json().status).toBe("CANCELLED");

      const repeated = await app.inject({
        method: "DELETE",
        url: `/v1/tasks/${task.task_id}`,
      });
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json().status).toBe("CANCELLED");
    } finally {
      await app.close();
    }
  });

  it("rejects invalid task requests and returns 404 for unknown tasks", async () => {
    const app = buildApp({ logger: false });

    try {
      const invalid = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        payload: { objective: "", workspace_root: "relative/path" },
      });
      expect(invalid.statusCode).toBe(400);

      const missing = await app.inject({
        method: "GET",
        url: "/v1/tasks/missing",
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("streams structured events with SSE", async () => {
    const store = new MemoryTaskStore();
    const app = buildApp({ logger: false, taskStore: store });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        payload: { objective: "查看项目", workspace_root: "D:\\workspace" },
      });
      const task = created.json();
      store.addEvent(task.task_id, {
        id: "1-0",
        event_type: "TOOL_COMPLETED",
        data: { event_type: "TOOL_COMPLETED", sequence: 1 },
      });
      await store.requestCancellation(task.task_id);

      const response = await app.inject({
        method: "GET",
        url: `/v1/tasks/${task.task_id}/events`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("event: TOOL_COMPLETED");
      expect(response.body).toContain("data: {\"event_type\":\"TOOL_COMPLETED\"");
    } finally {
      await app.close();
    }
  });
});
