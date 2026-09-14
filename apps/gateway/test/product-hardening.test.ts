import { afterEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/bootstrap.js";
import { MemoryTaskStore } from "../src/infrastructure/persistence/memory-task-store.js";
import { createTaskBodySchema, taskInteractionSchema } from "../src/domain/protocol.js";

afterEach(() => vi.unstubAllEnvs());

test("managed gateway requires its process token and rejects browser origins", async () => {
  vi.stubEnv("BIT_AGENT_GATEWAY_TOKEN", "test-token");
  const app = buildApp({ logger: false });
  try {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/health", headers: { authorization: "Bearer test-token" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health", headers: { authorization: "Bearer test-token", origin: "https://untrusted.example" } })).statusCode).toBe(403);
  } finally { await app.close(); }
});

test("permission modes and interaction actions are closed sets", () => {
  const body = { objective: "test", workspace_root: "D:\\workspace" };
  for (const permission_mode of ["read_only", "confirm", "edit"]) {
    expect(createTaskBodySchema.safeParse({ ...body, permission_mode }).success).toBe(true);
  }
  expect(createTaskBodySchema.safeParse({ ...body, permission_mode: "root" }).success).toBe(false);
  expect(taskInteractionSchema.safeParse({ action: "approve_everything" }).success).toBe(false);
});

test("review passes only supported actions to local storage", async () => {
  const store = new MemoryTaskStore();
  const review = vi.fn(async () => ({ changes: [] }));
  Object.assign(store, { reviewChange: review, getChanges: async () => ({ changes: [] }) });
  const app = buildApp({ logger: false, taskStore: store });
  try {
    expect((await app.inject({ method: "POST", url: "/v1/tasks/task/changes", payload: { change_id: "change", action: "force-delete" } })).statusCode).toBe(400);
    expect(review).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: "/v1/tasks/task/changes", payload: { change_id: "change", action: "undo" } })).statusCode).toBe(200);
    expect(review).toHaveBeenCalledExactlyOnceWith("task", "change", "undo");
  } finally { await app.close(); }
});

test("unmanaged gateway cannot receive model credentials", async () => {
  vi.stubEnv("BIT_AGENT_GATEWAY_TOKEN", "");
  const app = buildApp({ logger: false });
  try {
    expect((await app.inject({ method: "POST", url: "/v1/model", payload: {} })).statusCode).toBe(403);
  } finally { await app.close(); }
});
