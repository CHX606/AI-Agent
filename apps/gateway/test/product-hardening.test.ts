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

test("commit requests are validated before reaching local storage", async () => {
  const store = new MemoryTaskStore();
  const commit = vi.fn(async () => ({ commit: "abc", branch: "main", files: ["a.py"] }));
  Object.assign(store, { commitChanges: commit });
  const app = buildApp({ logger: false, taskStore: store });
  try {
    expect((await app.inject({ method: "POST", url: "/v1/tasks/t/git/commit", payload: { message: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/tasks/t/git/commit", payload: { message: "m", branch: 2 } })).statusCode).toBe(400);
    expect(commit).not.toHaveBeenCalled();
    const response = await app.inject({ method: "POST", url: "/v1/tasks/t/git/commit", payload: { message: "m", branch: "" } });
    expect(response.statusCode).toBe(200);
    expect(commit).toHaveBeenCalledExactlyOnceWith("t", { message: "m" });
  } finally { await app.close(); }
});

test("session search, rename and delete reach local storage", async () => {
  const store = new MemoryTaskStore();
  const list = vi.fn(async () => ({ sessions: [] }));
  const rename = vi.fn(async () => ({ session_id: "s", title: "新" }));
  const remove = vi.fn(async () => ({ deleted: true }));
  Object.assign(store, { listSessions: list, renameSession: rename, deleteSession: remove });
  const app = buildApp({ logger: false, taskStore: store });
  try {
    await app.inject({ method: "GET", url: `/v1/sessions?query=${encodeURIComponent(" 登录 ")}` });
    expect(list).toHaveBeenCalledWith(0, "登录");
    expect((await app.inject({ method: "GET", url: `/v1/sessions?query=${"x".repeat(201)}` })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/v1/sessions/s", payload: { title: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/v1/sessions/s", payload: { title: "新" } })).json()).toEqual({ session_id: "s", title: "新" });
    expect(rename).toHaveBeenCalledExactlyOnceWith("s", "新");
    expect((await app.inject({ method: "DELETE", url: "/v1/sessions/s" })).json()).toEqual({ deleted: true });
    expect(remove).toHaveBeenCalledExactlyOnceWith("s");
  } finally { await app.close(); }
});

test("unmanaged gateway cannot receive model credentials", async () => {
  vi.stubEnv("BIT_AGENT_GATEWAY_TOKEN", "");
  const app = buildApp({ logger: false });
  try {
    expect((await app.inject({ method: "POST", url: "/v1/model", payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/model/test", payload: {} })).statusCode).toBe(403);
  } finally { await app.close(); }
});

test("managed gateway forwards model connection tests", async () => {
  vi.stubEnv("BIT_AGENT_GATEWAY_TOKEN", "test-token");
  const store = new MemoryTaskStore();
  const probe = vi.fn(async () => ({ ok: true, api: "chat_completions" }));
  Object.assign(store, { testModel: probe });
  const app = buildApp({ logger: false, taskStore: store });
  try {
    const response = await app.inject({ method: "POST", url: "/v1/model/test",
      headers: { authorization: "Bearer test-token" }, payload: { model: "m", api: "auto" } });
    expect(response.json()).toEqual({ ok: true, api: "chat_completions" });
    expect(probe).toHaveBeenCalledExactlyOnceWith({ model: "m", api: "auto" });
  } finally { await app.close(); }
});
