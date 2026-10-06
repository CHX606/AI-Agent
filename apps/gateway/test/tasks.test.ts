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

  it.each([["auto", 202], ["always", 202], ["off", 202], ["sometimes", 400], [true, 400]])(
    "validates the independent acceptance mode (%s)", async (mode, status) => {
      const app = buildApp({ logger: false, taskStore: new MemoryTaskStore() });
      try {
        const response = await app.inject({ method: "POST", url: "/v1/tasks", payload: {
          objective: "inspect", workspace_root: "D:\\workspace", acceptance_mode: mode,
        } });
        expect(response.statusCode).toBe(status);
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

  it("serves session, change and diagnostic routes from any TaskStore", async () => {
    const store = new MemoryTaskStore();
    const app = buildApp({ logger: false, taskStore: store });
    try {
      const task = (await app.inject({ method: "POST", url: "/v1/tasks", payload: {
        objective: "inspect", workspace_root: "D:\\workspace", session_id: "s-1", multi_agent_mode: "on",
      } })).json();
      expect((await app.inject({ url: "/v1/sessions" })).json()).toEqual({ sessions: [] });
      expect((await app.inject({ url: "/v1/sessions/s-1" })).statusCode).toBe(404);
      expect((await app.inject({ url: `/v1/tasks/${task.task_id}/changes` })).json()).toEqual({ changes: [] });
      expect((await app.inject({ url: "/v1/tasks/missing/changes" })).statusCode).toBe(404);
      const diagnostics = await app.inject({ url: `/v1/diagnostics?task_id=${task.task_id}` });
      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.json().tasks).toHaveLength(1);
    } finally { await app.close(); }
  });

  it("lists and deletes long-term memories through the store", async () => {
    const store = new MemoryTaskStore();
    const deleted: string[] = [];
    Object.assign(store, {
      listMemories: async (root?: string) => ({ enabled: true, memories: [{ id: "m1", project: root ?? null }] }),
      deleteMemory: async (id: string) => { deleted.push(id); return { deleted: true, memory_id: id }; },
    });
    const app = buildApp({ logger: false, taskStore: store });
    try {
      const listed = await app.inject({ url: "/v1/memories?workspace_root=D%3A%5Cdemo" });
      expect(listed.json()).toEqual({ enabled: true, memories: [{ id: "m1", project: "D:\\demo" }] });
      expect((await app.inject({ url: "/v1/memories?workspace_root=relative" })).statusCode).toBe(400);
      expect((await app.inject({ method: "DELETE", url: "/v1/memories/m1" })).json().deleted).toBe(true);
      expect(deleted).toEqual(["m1"]);
    } finally { await app.close(); }
    const plain = buildApp({ logger: false, taskStore: new MemoryTaskStore() });
    try {
      expect((await plain.inject({ method: "DELETE", url: "/v1/memories/missing" })).statusCode).toBe(404);
    } finally { await plain.close(); }
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
