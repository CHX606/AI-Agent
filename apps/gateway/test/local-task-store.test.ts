import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { LocalTaskStore } from "../src/infrastructure/runtime/local-task-store.js";
import { IMAGE_LIMITS } from "../src/domain/image-input.js";
import type { TaskInteractionBody } from "../src/domain/protocol.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

async function localRuntime() {
  vi.stubEnv("BIT_AGENT_PROJECT_ROOT", resolve(import.meta.dirname, "../../.."));
  const stdout = new PassThrough();
  const requests: unknown[] = [];
  let respond = true;
  const child = Object.assign(new EventEmitter(), {
    stdout, stderr: new PassThrough(), exitCode: null as number | null, signalCode: null,
    stdin: new Writable({ write(chunk, _encoding, done) {
      const request = JSON.parse(String(chunk)) as { id: number };
      requests.push(request);
      if (respond) queueMicrotask(() => stdout.write(`${JSON.stringify({ id: request.id, result: { status: "ok" } })}\n`));
      done();
    } }),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const store = await LocalTaskStore.connect({ record() {}, failure: () => "D-1234567890abcdef" });
  return { store, requests, pause: () => { respond = false; }, resume: () => { respond = true; },
    exit: () => { child.exitCode = 1; child.emit("exit", 1, null); stdout.end(); } };
}

test("health distinguishes a temporary RPC timeout from a confirmed Python exit", async () => {
  const runtime = await localRuntime();
  vi.useFakeTimers();
  try {
    expect(await runtime.store.health()).toBe("ready");
    runtime.pause();
    const delayedHealth = runtime.store.health();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await delayedHealth).toBe("unavailable");
    runtime.resume();
    expect(await runtime.store.health()).toBe("ready");
    runtime.pause();
    const interruptedHealth = runtime.store.health();
    runtime.exit();
    expect(await interruptedHealth).toBe("stopped");
    const sent = runtime.requests.length;
    expect(await runtime.store.health()).toBe("stopped");
    expect(runtime.requests).toHaveLength(sent);
    await expect(runtime.store.getTask("existing-task")).rejects.toThrow("重新启动 Gateway");
  } finally { runtime.exit(); await runtime.store.close(); }
});

test("RPC preserves image attachments in task and interaction requests", async () => {
  const runtime = await localRuntime();
  const image = { name: "test.png", mime_type: "image/png" as const, data_url: "data:image/png;base64,iVBORw0KGgo=" };
  try {
    await runtime.store.createTask({ objective: "", workspace_root: "D:/project", images: [image], session_id: "session" });
    const interactions: TaskInteractionBody[] = [
      { action: "supplement", text: "", images: [image] }, { action: "replace", text: "", images: [image] },
      { action: "answer", text: "", images: [image], question_id: "q" },
    ];
    for (const input of interactions) await runtime.store.interactTask("task", input);
    const requests = runtime.requests as { method: string; params: { input?: { images?: unknown[] } } }[];
    expect(requests.slice(1).map(request => request.method)).toEqual(["create_task", "interact_task", "interact_task", "interact_task"]);
    expect(requests.slice(1).every(request => JSON.stringify(request.params.input?.images) === JSON.stringify([image]))).toBe(true);
  } finally { runtime.exit(); await runtime.store.close(); }
});

test("RPC rejects oversized UTF-8 requests before allocating pending work or writing to Python", async () => {
  const runtime = await localRuntime();
  try {
    const before = runtime.requests.length;
    await expect(runtime.store.call("create_task", { input: "图".repeat(Math.ceil(IMAGE_LIMITS.maxRequestBytes / 3)) }))
      .rejects.toMatchObject({ statusCode: 413, userMessage: expect.stringContaining("减少图片") });
    expect(runtime.requests).toHaveLength(before);
    expect(await runtime.store.health()).toBe("ready");
  } finally { runtime.exit(); await runtime.store.close(); }
});

test("RPC permits the exact byte limit and rejects the next byte", async () => {
  const runtime = await localRuntime();
  try {
    const envelope = Buffer.byteLength(`${JSON.stringify({ id: 2, method: "boundary", params: { padding: "" } })}\n`);
    await expect(runtime.store.call("boundary", { padding: "x".repeat(IMAGE_LIMITS.maxRequestBytes - envelope) }))
      .resolves.toEqual({ status: "ok" });
    const written = runtime.requests.length;
    await expect(runtime.store.call("boundary", { padding: "x".repeat(IMAGE_LIMITS.maxRequestBytes - envelope + 1) }))
      .rejects.toMatchObject({ statusCode: 413 });
    expect(runtime.requests).toHaveLength(written);
  } finally { runtime.exit(); await runtime.store.close(); }
});
