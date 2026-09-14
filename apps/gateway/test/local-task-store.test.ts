import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { LocalTaskStore } from "../src/infrastructure/runtime/local-task-store.js";

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
