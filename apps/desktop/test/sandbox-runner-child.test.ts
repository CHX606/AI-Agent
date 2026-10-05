import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { runSandboxChild } from "../../../scripts/sandbox-runner/child";

let child: EventEmitter & { stdout: { pipe: ReturnType<typeof vi.fn> }; stderr: { pipe: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.clearAllMocks();
  child = Object.assign(new EventEmitter(), { stdout: { pipe: vi.fn() }, stderr: { pipe: vi.fn() }, kill: vi.fn() });
  mocks.spawn.mockReturnValue(child);
});
afterEach(() => { child.removeAllListeners(); });

it("spawns official argv without a shell and streams output without closing broker streams", async () => {
  const signal = new AbortController().signal;
  const running = runSandboxChild(["C:/private/srt-win.exe", "exec", "safe arg"], { SAFE: "fixture" }, "C:/work", signal);
  expect(mocks.spawn).toHaveBeenCalledWith("C:/private/srt-win.exe", ["exec", "safe arg"], {
    cwd: "C:/work", env: { SAFE: "fixture" }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  expect(child.stdout.pipe).toHaveBeenCalledWith(process.stdout, { end: false });
  expect(child.stderr.pipe).toHaveBeenCalledWith(process.stderr, { end: false });
  child.emit("close", 4);
  expect(await running).toBe(4);
});

it("does not return on cancellation until the child has closed", async () => {
  const controller = new AbortController();
  let settled = false;
  const running = runSandboxChild(["C:/private/srt-win.exe"], {}, "C:/work", controller.signal);
  void running.then(() => { settled = true; });
  controller.abort();
  expect(child.kill).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", null);
  expect(await running).toBe(130);
});

it("refuses a cancelled operation before spawning", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(runSandboxChild(["C:/private/srt-win.exe"], {}, "C:/work", controller.signal)).rejects.toThrow("cancelled");
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("surfaces launch failures and removes the cancellation hook", async () => {
  const controller = new AbortController();
  const running = runSandboxChild(["C:/private/srt-win.exe"], {}, "C:/work", controller.signal);
  const failed = expect(running).rejects.toThrow("launch error");
  child.emit("error", new Error("launch error"));
  await failed;
  controller.abort();
  expect(child.kill).not.toHaveBeenCalled();
});
